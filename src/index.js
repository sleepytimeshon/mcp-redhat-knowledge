#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  DEFAULT_CHUNK,
  DOCUMENT_KINDS,
  formatArticle,
  formatCve,
  formatDocsRecord,
  formatErrata,
  formatKbaseRecord,
  formatSearchResults,
  getCveData,
  getErratumData,
  hasToken,
  kcsSearch,
  normalizeAdvisoryId,
  normalizeCveId,
  paginate,
  resolveDocumentKind,
  resolveProduct,
  solrEscapeTerm,
  solrQuote,
} from "./lib.js";
import { getDocsRecord, getKbaseRecord, KbaseUnavailable } from "./portal.js";

const SEARCH_FIELDS = "id,title,allTitle,abstract,documentKind,view_uri,product,lastModifiedDate";
const ERRATA_FIELDS = "id,title,abstract,documentKind,view_uri,portal_severity,portal_publication_date";

const paginationSchema = {
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(0)
    .describe(`Character offset into the rendered response. Default 0. Use the value from the previous call's "[truncated]" footer to fetch the next chunk.`),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .default(DEFAULT_CHUNK)
    .describe(`Maximum characters to return in this call. Default ${DEFAULT_CHUNK} keeps responses under typical MCP tool-result token caps.`),
};

const maxResultsSchema = z.number().int().min(1).max(50).optional().default(10).describe("Max results 1-50 (default: 10)");

const productSchema = z
  .string()
  .optional()
  .describe("Optional product filter, as a full product name or an alias such as 'OpenShift', 'RHEL', 'AAP', or 'Satellite'. No filter by default.");

const textResult = (text) => ({ content: [{ type: "text", text }] });

const server = new McpServer({
  name: "mcp-redhat-knowledge",
  version: "1.3.0",
});

server.registerTool(
  "searchKnowledgeBase",
  {
    description: "Search the Red Hat Knowledge Base for solutions and articles. Use error messages or technical keywords. Filter by product or documentType. Works without REDHAT_TOKEN (titles and abstracts only). Large result sets are paginated — call repeatedly with `offset` to read subsequent chunks.",
    inputSchema: {
      query: z.string().min(1).describe("Search keywords"),
      maxResults: maxResultsSchema,
      product: productSchema,
      documentType: z
        .string()
        .optional()
        .describe(`Optional document type filter (case-insensitive): ${DOCUMENT_KINDS.join(", ")}`),
      ...paginationSchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ query, maxResults, product, documentType, offset, limit }) => {
    const fq = [];
    if (product) fq.push(`product:${solrQuote(resolveProduct(product))}`);
    if (documentType) fq.push(`documentKind:${solrQuote(resolveDocumentKind(documentType))}`);

    const data = await kcsSearch(query, { rows: maxResults, fields: SEARCH_FIELDS, fq });
    return textResult(paginate(formatSearchResults(data), offset, limit, `searchKnowledgeBase: "${query}"`));
  }
);

server.registerTool(
  "getSolution",
  {
    description: "Get the full text of a Red Hat Knowledge Base solution or article by its numeric ID from searchKnowledgeBase. A solution returns Environment, Issue, Resolution, Root Cause, and Diagnostic Steps; an article returns its full body. Full text needs REDHAT_TOKEN for a subscribed account; without it, only the issue and summary from the search index are returned. Large documents are paginated — call repeatedly with `offset` to read subsequent chunks.",
    inputSchema: {
      solutionId: z.string().trim().min(1).describe("Solution or article ID from search results (e.g. '7097885')"),
      ...paginationSchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ solutionId, offset, limit }) => {
    const id = solutionId;
    const label = `getSolution: ${id}`;

    // Point other identifiers from search results at the tool that reads them
    if (/^RH[SBE]A-\d{4}:\d+$/i.test(id)) {
      return textResult(`${id} is an advisory ID; use getErrata to read it.`);
    }
    if (/^https?:\/\/(docs|access)\.redhat\.com\/.*documentation\//i.test(id)) {
      return textResult(`${id} is a documentation URL; use getDocumentation to read it.`);
    }

    let reason;
    if (!hasToken()) {
      reason = "REDHAT_TOKEN is not set; the server needs the offline API token of a subscribed Red Hat account to load full solutions";
    } else if (/^\d+$/.test(id)) {
      try {
        const record = await getKbaseRecord(id);
        if (!record) return textResult(`No solution or article found with ID ${id}`);
        return textResult(paginate(formatKbaseRecord(record), offset, limit, label));
      } catch (err) {
        if (!(err instanceof KbaseUnavailable)) throw err;
        reason = `the full document could not be loaded from the Customer Portal (${err.message})`;
      }
    }

    // Fall back to the search index: exact ID match (a free-text q falls back to fuzzy matches)
    const data = await kcsSearch("*:*", {
      rows: 10,
      fields: "id,title,allTitle,abstract,documentKind,view_uri,product,issue,solution_environment,solution_rootcause,solution_resolution,solution_diagnosticsteps,lastModifiedDate,createdDate,language",
      fq: [`id:${solrQuote(id)}`, 'documentKind:("Solution" OR "Article")'],
    });

    // Translations share the ID; prefer the English original
    const matches = (data?.response?.docs || []).filter((d) => String(d.id) === id);
    const doc = matches.find((d) => d.language === "en") || matches[0];
    if (!doc) {
      return textResult(`No solution or article found with ID ${id}`);
    }

    return textResult(paginate(formatArticle(doc, reason ? { reason } : undefined), offset, limit, label));
  }
);

server.registerTool(
  "getDocumentation",
  {
    description: "Get the full text of a Red Hat product documentation page (one chapter of a guide) from docs.redhat.com, as Markdown with procedures, commands, and notes intact. Pass a URL from searchDocumentation; add a '#section-id' fragment to get just that section. Shows previous/next chapter links, and the chapter list on a guide's index page. No token needed. Large chapters are paginated — call repeatedly with `offset` to read subsequent chunks.",
    inputSchema: {
      url: z.string().trim().min(1).describe("docs.redhat.com documentation URL (e.g. 'https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/managing_monitoring_and_updating_the_kernel/index')"),
      ...paginationSchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ url, offset, limit }) => {
    const doc = await getDocsRecord(url);
    if (!doc) {
      return textResult(`No documentation page found at ${url}. Use searchDocumentation to find current URLs.`);
    }
    return textResult(paginate(formatDocsRecord(doc), offset, limit, `getDocumentation: ${url}`));
  }
);

server.registerTool(
  "searchDocumentation",
  {
    description: "Search Red Hat product documentation for how-to guides and best practices. Works without REDHAT_TOKEN. Large result sets are paginated — call repeatedly with `offset` to read subsequent chunks.",
    inputSchema: {
      topic: z.string().min(1).describe("Topic to search"),
      product: productSchema,
      maxResults: maxResultsSchema,
      ...paginationSchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ topic, product, maxResults, offset, limit }) => {
    const fq = ['documentKind:"Documentation"'];
    if (product) fq.push(`product:${solrQuote(resolveProduct(product))}`);

    const data = await kcsSearch(topic, { rows: maxResults, fields: SEARCH_FIELDS, fq });
    return textResult(paginate(formatSearchResults(data), offset, limit, `searchDocumentation: "${topic}"`));
  }
);

server.registerTool(
  "searchErrata",
  {
    description: "Search Red Hat errata (RHSA, RHBA, RHEA advisories), newest first. Give at least one of cve, package, or query; narrow with product, severity, or advisoryType. Use getErrata for an advisory's full details. Works without REDHAT_TOKEN. Large result sets are paginated — call repeatedly with `offset` to read subsequent chunks.",
    inputSchema: {
      cve: z.string().optional().describe("CVE ID the advisory fixes (e.g. 'CVE-2024-6387')"),
      package: z.string().optional().describe("Package name the advisory ships (e.g. 'openssh', 'kernel')"),
      query: z.string().optional().describe("Free-text keywords"),
      product: z
        .string()
        .optional()
        .describe("Optional product name prefix or alias (e.g. 'RHEL', 'Red Hat Enterprise Linux for x86_64')"),
      severity: z.enum(["Critical", "Important", "Moderate", "Low"]).optional().describe("Security severity"),
      advisoryType: z
        .enum(["Security Advisory", "Bug Fix Advisory", "Product Enhancement Advisory"])
        .optional()
        .describe("Advisory type"),
      maxResults: maxResultsSchema,
      ...paginationSchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ cve, package: pkg, query, product, severity, advisoryType, maxResults, offset, limit }) => {
    if (!cve && !pkg && !query) {
      throw new Error("Give at least one of cve, package, or query");
    }

    const fq = ['documentKind:"Errata"'];
    if (cve) fq.push(`portal_CVE:${solrQuote(normalizeCveId(cve))}`);
    if (pkg) fq.push(`portal_package:${solrEscapeTerm(pkg.trim())}\\-*`);
    if (product) fq.push(`portal_product_names:${solrEscapeTerm(resolveProduct(product))}*`);
    if (severity) fq.push(`portal_severity:${solrQuote(severity)}`);
    if (advisoryType) fq.push(`portal_advisory_type:${solrQuote(advisoryType)}`);

    const data = await kcsSearch(query || "*:*", {
      rows: maxResults,
      fields: ERRATA_FIELDS,
      fq,
      sort: "portal_publication_date desc",
    });

    const label = [cve, pkg, query].filter(Boolean).join(" ");
    return textResult(paginate(formatSearchResults(data), offset, limit, `searchErrata: "${label}"`));
  }
);

server.registerTool(
  "getErrata",
  {
    description: "Get errata/advisory details by advisory ID (RHSA, RHBA, RHEA). Returns severity, CVEs, description, affected products, and fixed packages. Uses the public Security Data API; no token needed. Large advisories are paginated — call repeatedly with `offset` to read subsequent chunks.",
    inputSchema: {
      advisoryId: z.string().describe("Advisory ID (e.g. 'RHSA-2024:1234')"),
      ...paginationSchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ advisoryId, offset, limit }) => {
    const id = normalizeAdvisoryId(advisoryId);
    const data = await getErratumData(id);
    return textResult(paginate(formatErrata(data), offset, limit, `getErrata: ${id}`));
  }
);

server.registerTool(
  "getCve",
  {
    description: "Get Red Hat's assessment of a CVE: severity, CVSS, details, statement, mitigation, the advisories and packages that fix it per product, and products not affected or not fixed. Uses the public Security Data API; no token needed. Large responses are paginated — call repeatedly with `offset` to read subsequent chunks.",
    inputSchema: {
      cveId: z.string().describe("CVE ID (e.g. 'CVE-2024-6387')"),
      ...paginationSchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ cveId, offset, limit }) => {
    const id = normalizeCveId(cveId);
    const data = await getCveData(id);
    return textResult(paginate(formatCve(data), offset, limit, `getCve: ${id}`));
  }
);

// --- Start server ---

const transport = new StdioServerTransport();
await server.connect(transport);
