// Red Hat API clients, query helpers, and response formatters for mcp-redhat-knowledge.
// Kept separate from src/index.js, which starts the stdio transport, so tests can import it.

import { convertHtml, htmlToMarkdown } from "./html.js";

export const TOKEN_URL = "https://sso.redhat.com/auth/realms/redhat-external/protocol/openid-connect/token";
export const KCS_BASE = "https://access.redhat.com/hydra/rest/search/kcs";
export const SECURITY_BASE = "https://access.redhat.com/hydra/rest/securitydata";
const CLIENT_ID = "rhsm-api";

export const FETCH_TIMEOUT_MS = 30000;
export const SUBSCRIBER_ONLY = "subscriber_only";

// --- HTTP ---

export async function fetchWithTimeout(url, init = {}) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    if (err?.name === "TimeoutError") {
      throw new Error(`Request to ${new URL(url).host} timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }
}

// --- Authentication ---

let cachedToken = null;
let tokenExpiry = 0;

export function hasToken() {
  return Boolean(process.env.REDHAT_TOKEN);
}

export function clearTokenCache() {
  cachedToken = null;
  tokenExpiry = 0;
}

// Exchange REDHAT_TOKEN for an access token; return null when no offline token is set
export async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const offlineToken = process.env.REDHAT_TOKEN;
  if (!offlineToken) return null;

  const res = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: offlineToken,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error("Token exchange returned no access_token");
  }
  const lifetime = Number.isFinite(data.expires_in) ? data.expires_in : 300;
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + Math.max(lifetime - 60, 0) * 1000;
  return cachedToken;
}

// --- Solr query helpers ---

// Quote a value as a Solr phrase, escaping backslashes and double quotes
export function solrQuote(value) {
  return `"${String(value).replace(/[\\"]/g, "\\$&")}"`;
}

// Escape every Solr special character in a bare term (for use before a trailing wildcard)
export function solrEscapeTerm(value) {
  return String(value).replace(/[\\+\-!():^[\]"{}~*?|&/\s]/g, "\\$&");
}

// --- KCS search ---

export async function kcsSearch(query, { rows = 10, fields, fq, sort } = {}) {
  const params = new URLSearchParams({ q: query, rows: String(rows) });
  if (fields) params.set("fl", fields);
  if (sort) params.set("sort", sort);
  for (const f of [fq ?? []].flat()) params.append("fq", f);
  const url = `${KCS_BASE}?${params}`;

  const send = async () => {
    const token = await getAccessToken();
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetchWithTimeout(url, { headers });
  };

  let res = await send();
  if (res.status === 401 && hasToken()) {
    // The cached access token may have been revoked early; exchange again once
    clearTokenCache();
    res = await send();
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`KCS search failed (${res.status}): ${text}`);
  }

  return res.json();
}

// --- Security Data API (public, no authentication) ---

async function getSecurityData(path, label) {
  const res = await fetchWithTimeout(`${SECURITY_BASE}/${path}`, {
    headers: { Accept: "application/json" },
  });

  if (res.status === 404) {
    throw new Error(`${label} not found`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Security Data API request for ${label} failed (${res.status}): ${text}`);
  }

  return res.json();
}

export function getErratumData(advisoryId) {
  return getSecurityData(`csaf/${encodeURIComponent(advisoryId)}.json`, `Advisory ${advisoryId}`);
}

export function getCveData(cveId) {
  return getSecurityData(`cve/${encodeURIComponent(cveId)}.json`, `${cveId}`);
}

// --- Identifier normalization ---

export function normalizeAdvisoryId(input) {
  const id = String(input).trim().toUpperCase();
  if (!/^RH[SBE]A-\d{4}:\d{4,}$/.test(id)) {
    throw new Error(`Invalid advisory ID "${input}": expected RHSA-, RHBA-, or RHEA- followed by YYYY:NNNN (e.g. RHSA-2024:1234)`);
  }
  return id;
}

export function normalizeCveId(input) {
  const id = String(input).trim().toUpperCase();
  if (!/^CVE-\d{4}-\d{4,}$/.test(id)) {
    throw new Error(`Invalid CVE ID "${input}": expected CVE-YYYY-NNNN (e.g. CVE-2024-6387)`);
  }
  return id;
}

// --- Product names and document kinds ---

export const PRODUCT_ALIASES = {
  "openshift": "Red Hat OpenShift Container Platform",
  "ocp": "Red Hat OpenShift Container Platform",
  "rhel": "Red Hat Enterprise Linux",
  "enterprise linux": "Red Hat Enterprise Linux",
  "ansible": "Red Hat Ansible Automation Platform",
  "aap": "Red Hat Ansible Automation Platform",
  "satellite": "Red Hat Satellite",
  "idm": "Red Hat Enterprise Linux",
  "ipa": "Red Hat Enterprise Linux",
  "freeipa": "Red Hat Enterprise Linux",
  "directory server": "Red Hat Directory Server",
  "certificate system": "Red Hat Certificate System",
  "sso": "Red Hat Single Sign-On",
  "keycloak": "Red Hat build of Keycloak",
  "quay": "Red Hat Quay",
  "acm": "Red Hat Advanced Cluster Management for Kubernetes",
  "acs": "Red Hat Advanced Cluster Security for Kubernetes",
  "service mesh": "Red Hat OpenShift Service Mesh",
  "virtualization": "Red Hat OpenShift Virtualization",
  "openstack": "Red Hat OpenStack Platform",
  "ceph": "Red Hat Ceph Storage",
  "data grid": "Red Hat Data Grid",
  "amq": "Red Hat AMQ",
  "serverless": "Red Hat OpenShift Serverless",
  "pipelines": "Red Hat OpenShift Pipelines",
  "gitops": "Red Hat OpenShift GitOps",
  "logging": "Red Hat OpenShift Logging",
};

export function resolveProduct(input) {
  if (!input) return undefined;
  const trimmed = input.trim();
  return PRODUCT_ALIASES[trimmed.toLowerCase()] || trimmed;
}

// documentKind values are case-sensitive in the index; map common spellings to them
export const DOCUMENT_KINDS = ["Solution", "Article", "Documentation", "Errata", "Cve", "Vulnerability", "Discussion"];

export function resolveDocumentKind(input) {
  if (!input) return undefined;
  const trimmed = input.trim();
  return DOCUMENT_KINDS.find((k) => k.toLowerCase() === trimmed.toLowerCase()) || trimmed;
}

// --- Formatting helpers ---

function truncate(text, max) {
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

// KCS returns Knowledge Base URLs relative to the Customer Portal (e.g. /kb/7097885)
export function absoluteUrl(uri) {
  if (!uri) return uri;
  return uri.startsWith("/") ? `https://access.redhat.com${uri}` : uri;
}

// Documentation entries carry their title in allTitle rather than title
function docTitle(doc) {
  return doc.title || doc.allTitle || "Untitled";
}

function list(value) {
  return Array.isArray(value) ? value.join(", ") : value;
}

export function formatSearchResults(data, { abstractChars = 300 } = {}) {
  const docs = data?.response?.docs || [];
  if (docs.length === 0) return "No results found.";

  const start = data.response.start || 0;
  const total = data.response.numFound ?? docs.length;
  const header = `Showing results ${start + 1}-${start + docs.length} of ${total}`;

  const body = docs.map((doc, i) => {
    const parts = [`${start + i + 1}. **${docTitle(doc)}**`];
    if (doc.id) parts.push(`   ID: ${doc.id}`);
    if (doc.documentKind) parts.push(`   Type: ${doc.documentKind}`);
    if (doc.portal_severity && doc.portal_severity !== "None") parts.push(`   Severity: ${doc.portal_severity}`);
    if (doc.product) parts.push(`   Products: ${list(doc.product)}`);
    if (doc.view_uri) parts.push(`   URL: ${absoluteUrl(doc.view_uri)}`);
    if (doc.portal_publication_date) parts.push(`   Published: ${doc.portal_publication_date}`);
    if (doc.lastModifiedDate) parts.push(`   Modified: ${doc.lastModifiedDate}`);
    if (doc.abstract) parts.push(`   ${truncate(doc.abstract, abstractChars)}`);
    return parts.join("\n");
  }).join("\n\n");

  const readers = {
    Solution: "getSolution with the ID",
    Article: "getSolution with the ID",
    Documentation: "getDocumentation with the URL",
    Errata: "getErrata with the ID",
    Cve: "getCve with the CVE ID in the title",
  };
  const hints = [...new Set(docs.map((d) => d.documentKind).filter((k) => readers[k]))]
    .map((k) => `${k}: ${readers[k]}`);
  const footer = hints.length ? `\n\nRead a result in full — ${hints.join("; ")}.` : "";

  return `${header}\n\n${body}${footer}`;
}

// Format a search-index record of a solution or article. The index never carries a solution's
// environment, root cause, resolution, or diagnostic steps (they come back as "subscriber_only"
// anonymously and are omitted with a token), so name the missing sections and say why.
export function formatArticle(doc, { reason = "the search index does not carry them" } = {}) {
  const parts = [];
  parts.push(`# ${docTitle(doc)}`);
  if (doc.id) parts.push(`**ID:** ${doc.id}`);
  if (doc.documentKind) parts.push(`**Type:** ${doc.documentKind}`);
  if (doc.view_uri) parts.push(`**URL:** ${absoluteUrl(doc.view_uri)}`);
  if (doc.product) parts.push(`**Products:** ${list(doc.product)}`);
  if (doc.createdDate) parts.push(`**Created:** ${doc.createdDate}`);
  if (doc.lastModifiedDate) parts.push(`**Modified:** ${doc.lastModifiedDate}`);

  const sections = [
    ["Issue", doc.issue],
    ["Environment", doc.solution_environment],
    ["Root Cause", doc.solution_rootcause],
    ["Resolution", doc.solution_resolution],
    ["Diagnostic Steps", doc.solution_diagnosticsteps],
  ];

  const missing = [];
  let shown = 0;
  for (const [heading, raw] of sections) {
    const content = Array.isArray(raw) ? raw.join("\n\n") : raw;
    if (!content || content === SUBSCRIBER_ONLY) {
      if (heading !== "Issue" && (content === SUBSCRIBER_ONLY || doc.documentKind === "Solution")) missing.push(heading);
      continue;
    }
    parts.push(`\n## ${heading}\n${content}`);
    shown += 1;
  }

  if (shown === 0 && doc.abstract) {
    parts.push(`\n## Summary\n${doc.abstract}`);
  }

  if (missing.length > 0) {
    parts.push(`\n> Partial document from the search index: ${missing.join(", ")} not included because ${reason}.`);
  }

  return parts.join("\n");
}

const KBASE_SECTIONS = [
  ["Environment", "environment"],
  ["Issue", "issue"],
  ["Resolution", "resolution"],
  ["Root Cause", "rootCause"],
  ["Diagnostic Steps", "diagnosticSteps"],
];

// Format a full Knowledge Base solution or article record loaded from the Customer Portal
export function formatKbaseRecord(kb) {
  const kind = kb.type === "solution" ? "Solution" : kb.type === "article" ? "Article" : kb.type || "Document";
  const path = kb.type === "solution" ? "solutions" : kb.type === "article" ? "articles" : "kb";
  const parts = [`# ${kb.title}`];
  parts.push(`**ID:** ${kb.id}`);
  const qualifier = kb.type === "solution" ? kb.kcsState : kb.articleType;
  parts.push(`**Type:** ${kind}${qualifier ? ` (${qualifier})` : ""}`);
  parts.push(`**URL:** https://access.redhat.com/${path}/${kb.id}`);
  const products = (kb.products || []).map((p) => p?.name).filter(Boolean);
  if (products.length) parts.push(`**Products:** ${[...new Set(products)].join(", ")}`);
  const areas = (kb.sbr || []).map((x) => x?.name).filter(Boolean);
  if (areas.length) parts.push(`**Support area:** ${areas.join(", ")}`);
  if (kb.updated) parts.push(`**Updated:** ${kb.updated}`);
  if (kb.insightsUrl) parts.push(`**Red Hat Lightspeed rule:** ${kb.insightsUrl}`);

  let shown = 0;
  for (const [heading, key] of KBASE_SECTIONS) {
    const md = htmlToMarkdown(kb[key], { headingShift: 1 });
    if (md) {
      parts.push(`\n## ${heading}\n${md}`);
      shown += 1;
    }
  }

  const body = htmlToMarkdown(kb.body);
  if (body) {
    parts.push(`\n${body}`);
  } else if (shown === 0) {
    const abstract = htmlToMarkdown(kb.abstract);
    if (abstract) parts.push(`\n## Summary\n${abstract}`);
  }

  if (kb.type === "solution" && !kb.resolution) {
    parts.push("\n> The Customer Portal returned no resolution for this solution. The subscription behind REDHAT_TOKEN may not include it.");
  }

  const attachments = (kb.attachments || []).filter((a) => a && typeof a === "object");
  if (attachments.length) {
    const lines = attachments.map((a) => {
      const name = a.name || a.fileName || a.title || "attachment";
      const url = a.url || a.link || a.href;
      return url ? `- [${name}](${absoluteUrl(url)})` : `- ${name}`;
    });
    parts.push(`\n## Attachments\n${lines.join("\n")}`);
  }

  return parts.join("\n");
}

const DOCS_ORIGIN = "https://docs.redhat.com";

function docsUrl(path, locale = "en") {
  if (!path) return null;
  if (/^https?:/.test(path)) return path;
  return path.startsWith(`/${locale}/`) ? `${DOCS_ORIGIN}${path}` : `${DOCS_ORIGIN}/${locale}${path}`;
}

// Format a docs.redhat.com page record (one chapter of a guide, or the guide's landing page)
export function formatDocsRecord(doc) {
  const locale = (doc.locale || "en").split("-")[0];
  const page = new URL(doc.pageUrl);
  const { markdown, fragmentFound } = convertHtml(doc.html, { base: page.href, fragment: doc.fragment || undefined });

  const guide = doc.title?.name;
  const version = doc.title?.productVersion?.name;
  const parts = [`# ${doc.name || guide || "Documentation"}`];
  if (guide) parts.push(`**Guide:** ${guide}${doc.productName ? ` (${doc.productName}${version ? ` ${version}` : ""})` : ""}`);
  parts.push(`**URL:** ${page.href}${doc.fragment ? `#${doc.fragment}` : ""}`);
  const versions = (doc.productVersions || []).map((v) => v?.name).filter(Boolean);
  if (versions.length > 1) parts.push(`**Product versions with documentation:** ${versions.join(", ")}`);
  if (doc.fragment && !fragmentFound) {
    parts.push(`\n> Section "#${doc.fragment}" was not found on this page; showing the whole page.`);
  } else if (doc.fragment) {
    parts.push(`\n> Showing only section "#${doc.fragment}" of this page. Omit the "#..." part of the URL for the whole page.`);
  }

  parts.push(`\n${markdown}`);

  // Chapters of this guide, in order, for navigation
  const toc = (doc.toc || []).filter((t) => t && t.visible !== false && t.url);
  const here = toc.findIndex((t) => docsUrl(t.url, locale) === `${page.origin}${page.pathname}`);
  const nav = [];
  if (here > 0) nav.push(`- Previous: [${toc[here - 1].title}](${docsUrl(toc[here - 1].url, locale)})`);
  if (here >= 0 && here < toc.length - 1) nav.push(`- Next: [${toc[here + 1].title}](${docsUrl(toc[here + 1].url, locale)})`);
  if (nav.length) parts.push(`\n## Navigation\n${nav.join("\n")}`);

  const isLanding = here === 0 || /\/index$/.test(page.pathname);
  if (isLanding && toc.length > 1) {
    parts.push(`\n## Chapters\n${toc.map((t) => `- [${t.title}](${docsUrl(t.url, locale)})`).join("\n")}`);
  }

  return parts.join("\n");
}

const ARCH_SUFFIX = /\.(x86_64|aarch64|ppc64le|ppc64|s390x|i686|noarch|src)$/;

// Package NEVRAs a CSAF advisory fixes, without architecture duplicates
export function csafFixedPackages(csaf) {
  const byProductId = new Map(
    (csaf.product_tree?.relationships || []).map((r) => [r.full_product_name?.product_id, r.product_reference]),
  );
  const packages = new Set();
  for (const vuln of csaf.vulnerabilities || []) {
    for (const id of vuln.product_status?.fixed || []) {
      const ref = byProductId.get(id) ?? id.slice(id.indexOf(":") + 1);
      packages.add(ref.replace(ARCH_SUFFIX, ""));
    }
  }
  return [...packages].sort();
}

// Product names (category product_name) in a CSAF product tree
export function csafProductNames(csaf) {
  const names = new Set();
  const walk = (branch) => {
    if (branch.category === "product_name" && branch.product?.name) names.add(branch.product.name);
    (branch.branches || []).forEach(walk);
  };
  (csaf.product_tree?.branches || []).forEach(walk);
  return [...names];
}

function capped(items, max, render = (x) => `- ${x}`) {
  const lines = items.slice(0, max).map(render);
  if (items.length > max) lines.push(`- … and ${items.length - max} more`);
  return lines.join("\n");
}

export function formatErrata(csaf) {
  const parts = [];
  const doc = csaf.document || {};
  parts.push(`# ${doc.title || doc.tracking?.id || "Unknown Advisory"}`);

  if (doc.tracking?.id) parts.push(`**Advisory:** ${doc.tracking.id}`);
  const self = (doc.references || []).find((r) => r.category === "self");
  if (self?.url) parts.push(`**URL:** ${self.url}`);
  if (doc.aggregate_severity?.text) parts.push(`**Severity:** ${doc.aggregate_severity.text}`);
  if (doc.tracking?.initial_release_date) parts.push(`**Released:** ${doc.tracking.initial_release_date}`);
  if (doc.tracking?.current_release_date) parts.push(`**Updated:** ${doc.tracking.current_release_date}`);

  const vulns = (csaf.vulnerabilities || []).filter((v) => v.cve);
  if (vulns.length > 0) {
    const cves = vulns.map((v) => {
      const impact = (v.threats || []).find((t) => t.category === "impact")?.details;
      return impact ? `${v.cve} (${impact})` : v.cve;
    });
    parts.push(`\n## CVEs (${cves.length})\n${cves.join(", ")}`);
  }

  const headings = { summary: "Summary", general: "Details", description: "Description" };
  for (const note of doc.notes || []) {
    if (headings[note.category] && note.text) {
      parts.push(`\n## ${headings[note.category]}\n${note.text}`);
    }
  }

  const products = csafProductNames(csaf);
  if (products.length > 0) {
    parts.push(`\n## Affected Products (${products.length})\n${capped(products, 50)}`);
  }

  const packages = csafFixedPackages(csaf);
  if (packages.length > 0) {
    parts.push(`\n## Fixed Packages (${packages.length})\n${capped(packages, 100)}`);
  }

  return parts.join("\n");
}

export function formatCve(cve) {
  const parts = [`# ${cve.name || "Unknown CVE"}`];
  parts.push(`**URL:** https://access.redhat.com/security/cve/${cve.name}`);
  if (cve.threat_severity) parts.push(`**Severity:** ${cve.threat_severity}`);
  if (cve.public_date) parts.push(`**Public:** ${cve.public_date}`);
  if (cve.cvss3?.cvss3_base_score) {
    parts.push(`**CVSS v3:** ${cve.cvss3.cvss3_base_score} (${cve.cvss3.cvss3_scoring_vector})`);
  }
  if (cve.cwe) parts.push(`**CWE:** ${cve.cwe}`);
  if (cve.bugzilla?.url) parts.push(`**Bugzilla:** ${cve.bugzilla.description} (${cve.bugzilla.url})`);

  const details = [...new Set([cve.details ?? []].flat().map((d) => d.trim()).filter(Boolean))];
  if (details.length > 0) parts.push(`\n## Details\n${details.join("\n\n")}`);
  if (cve.statement) parts.push(`\n## Statement\n${cve.statement}`);
  const mitigation = cve.mitigation?.value ?? cve.mitigation;
  if (typeof mitigation === "string" && mitigation) parts.push(`\n## Mitigation\n${mitigation}`);

  const releases = cve.affected_release || [];
  if (releases.length > 0) {
    const seen = new Set();
    const rows = [];
    for (const r of releases) {
      const key = `${r.product_name}|${r.advisory}|${r.package}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(`| ${r.product_name} | ${r.advisory || ""} | ${r.package || ""} | ${(r.release_date || "").slice(0, 10)} |`);
    }
    const shown = rows.slice(0, 100);
    if (rows.length > 100) shown.push(`| … and ${rows.length - 100} more | | | |`);
    parts.push(`\n## Fixed In (${rows.length})\n| Product | Advisory | Package | Released |\n|---|---|---|---|\n${shown.join("\n")}`);
  }

  const states = cve.package_state || [];
  if (states.length > 0) {
    parts.push(`\n## Other Product States (${states.length})\n${capped(states, 100, (s) => `- ${s.product_name}: ${s.package_name} — ${s.fix_state}`)}`);
  }

  return parts.join("\n");
}

// --- Pagination ---

export const DEFAULT_CHUNK = 30000;

export function paginate(text, offset, limit, label) {
  const total = text.length;
  const start = Math.min(offset, total);
  const end = Math.min(start + limit, total);
  const slice = text.slice(start, end);
  const header = `# ${label}\n# chars ${start}-${end} of ${total}\n\n`;
  let footer = "";
  if (end < total) {
    footer = `\n\n[truncated: showing chars ${start}-${end} of ${total}. Call again with offset=${end} for the next chunk.]`;
  } else if (offset > 0 && offset >= total) {
    footer = `[offset ${offset} is past the end of the ${total}-character response. Call again with a smaller offset.]`;
  }
  return `${header}${slice}${footer}`;
}
