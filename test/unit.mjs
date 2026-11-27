#!/usr/bin/env node
// Offline tests of src/lib.js: query helpers, formatters, pagination, and the KCS client's
// authentication paths, against checked-in fixtures and a stubbed fetch. Needs no network.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import * as lib from "../src/lib.js";

const fixture = async (name) => JSON.parse(await readFile(new URL(`fixtures/${name}`, import.meta.url), "utf8"));

const realFetch = globalThis.fetch;
const realToken = process.env.REDHAT_TOKEN;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realToken === undefined) delete process.env.REDHAT_TOKEN;
  else process.env.REDHAT_TOKEN = realToken;
  lib.clearTokenCache();
});

// Replace fetch with a handler; return the list of calls it receives
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  return calls;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("Solr helpers", () => {
  it("quotes phrases and escapes quotes and backslashes", () => {
    assert.equal(lib.solrQuote("Red Hat"), '"Red Hat"');
    assert.equal(lib.solrQuote('a"b\\c'), '"a\\"b\\\\c"');
  });

  it("escapes special characters in bare terms", () => {
    assert.equal(lib.solrEscapeTerm("Red Hat"), "Red\\ Hat");
    assert.equal(lib.solrEscapeTerm("a-b*c:d"), "a\\-b\\*c\\:d");
  });
});

describe("identifier normalization", () => {
  it("normalizes advisory IDs", () => {
    assert.equal(lib.normalizeAdvisoryId(" rhsa-2024:1234 "), "RHSA-2024:1234");
    assert.equal(lib.normalizeAdvisoryId("RHBA-2026:99592"), "RHBA-2026:99592");
    for (const bad of ["../../foo", "RHSA-2024-1234", "RHXA-2024:1234", ""]) {
      assert.throws(() => lib.normalizeAdvisoryId(bad), /Invalid advisory ID/);
    }
  });

  it("normalizes CVE IDs", () => {
    assert.equal(lib.normalizeCveId("cve-2024-6387"), "CVE-2024-6387");
    assert.throws(() => lib.normalizeCveId("CVE-2024"), /Invalid CVE ID/);
  });

  it("resolves product aliases and document kinds", () => {
    assert.equal(lib.resolveProduct(" RHEL "), "Red Hat Enterprise Linux");
    assert.equal(lib.resolveProduct("Red Hat Fuse"), "Red Hat Fuse");
    assert.equal(lib.resolveProduct(undefined), undefined);
    assert.equal(lib.resolveDocumentKind("solution"), "Solution");
    assert.equal(lib.resolveDocumentKind("CVE"), "Cve");
    assert.equal(lib.resolveDocumentKind("BlogPost"), "BlogPost");
  });
});

describe("paginate", () => {
  it("returns small responses whole", () => {
    assert.equal(lib.paginate("abc", 0, 10, "t"), "# t\n# chars 0-3 of 3\n\nabc");
  });

  it("adds a footer with the next offset when truncated", () => {
    const out = lib.paginate("abcdef", 2, 2, "t");
    assert.match(out, /# chars 2-4 of 6\n\ncd/);
    assert.match(out, /Call again with offset=4/);
  });

  it("explains an offset past the end", () => {
    assert.match(lib.paginate("abc", 10, 5, "t"), /offset 10 is past the end of the 3-character response/);
  });
});

describe("formatSearchResults", () => {
  it("shows totals, products, absolute URLs, and trimmed abstracts", () => {
    const out = lib.formatSearchResults({
      response: {
        numFound: 300,
        start: 0,
        docs: [
          { id: "118443", title: "Kernel panic", documentKind: "Solution", product: ["Red Hat Enterprise Linux"], view_uri: "/kb/118443", abstract: "x".repeat(500) },
          { id: "doc", allTitle: "Configure chrony", view_uri: "https://docs.redhat.com/a" },
        ],
      },
    });
    assert.match(out, /^Showing results 1-2 of 300/);
    assert.match(out, /Products: Red Hat Enterprise Linux/);
    assert.match(out, /URL: https:\/\/access\.redhat\.com\/kb\/118443/);
    assert.match(out, /URL: https:\/\/docs\.redhat\.com\/a/);
    assert.match(out, /\*\*Configure chrony\*\*/);
    assert.match(out, /x{300}…/);
    assert.doesNotMatch(out, /x{301}/);
  });

  it("reports no results", () => {
    assert.equal(lib.formatSearchResults({ response: { docs: [] } }), "No results found.");
  });
});

describe("formatArticle", () => {
  const doc = {
    id: "7097885",
    title: "kernel panic",
    issue: ["Kernel panic with logs"],
    solution_resolution: "subscriber_only",
    solution_rootcause: "subscriber_only",
  };

  it("renders public sections and names the missing ones", () => {
    const out = lib.formatArticle(doc);
    assert.match(out, /## Issue\nKernel panic with logs/);
    assert.doesNotMatch(out, /## Resolution/);
    assert.match(out, /Partial document from the search index: Root Cause, Resolution not included because the search index does not carry them\./);
  });

  it("names the sections an authenticated search omits, with the caller's reason", () => {
    const out = lib.formatArticle(
      { id: "7097885", documentKind: "Solution", view_uri: "/kb/7097885", issue: ["Kernel panic"] },
      { reason: "REDHAT_TOKEN is not set" },
    );
    assert.match(out, /Environment, Root Cause, Resolution, Diagnostic Steps not included because REDHAT_TOKEN is not set\./);
  });

  it("adds no note to non-solution documents without solution sections", () => {
    assert.doesNotMatch(lib.formatArticle({ id: "1", documentKind: "Article", abstract: "A" }), /Partial document/);
  });

  it("falls back to the abstract when no section is public", () => {
    const out = lib.formatArticle({ id: "1", abstract: "Short summary", solution_resolution: "subscriber_only" });
    assert.match(out, /## Summary\nShort summary/);
  });
});

describe("formatErrata", async () => {
  const csaf = await fixture("RHSA-2024-1234.json");

  it("renders severity, CVE impacts, summary, and details", () => {
    const out = lib.formatErrata(csaf);
    assert.match(out, /^# Red Hat Security Advisory: openvswitch2\.17 security update/);
    assert.match(out, /\*\*URL:\*\* https:\/\/access\.redhat\.com\/errata\/RHSA-2024:1234/);
    assert.match(out, /\*\*Severity:\*\* Important/);
    assert.match(out, /CVE-2023-3966 \(Important\), CVE-2023-5366 \(Moderate\)/);
    assert.match(out, /## Summary\n/);
    assert.match(out, /## Details\nOpen vSwitch provides/);
  });

  it("lists product names, not packages, as affected products", () => {
    assert.deepEqual(lib.csafProductNames(csaf), ["Fast Datapath for Red Hat Enterprise Linux 8"]);
  });

  it("lists fixed packages without architecture duplicates", () => {
    assert.deepEqual(lib.csafFixedPackages(csaf), [
      "openvswitch2.17-0:2.17.0-148.el8fdp",
      "openvswitch2.17-devel-0:2.17.0-148.el8fdp",
    ]);
  });
});

describe("formatCve", async () => {
  const cve = await fixture("CVE-2024-6387.json");
  const out = lib.formatCve(cve);

  it("renders severity, CVSS, and a deduplicated details section", () => {
    assert.match(out, /\*\*Severity:\*\* Important/);
    assert.match(out, /\*\*CVSS v3:\*\* 8\.1 \(CVSS:3\.1\//);
    assert.equal(out.match(/A security regression/g).length, 1);
    assert.match(out, /## Mitigation\n/);
  });

  it("lists each fix once and the other product states", () => {
    assert.match(out, /## Fixed In \(2\)/);
    assert.match(out, /\| Red Hat Enterprise Linux 9 \| RHSA-2024:4312 \| openssh-0:8\.7p1-38\.el9_4\.1 \| 2024-07-03 \|/);
    assert.match(out, /## Other Product States \(2\)\n- Red Hat Ceph Storage 5: openssh — Not affected/);
  });
});

describe("kcsSearch", () => {
  it("searches anonymously when REDHAT_TOKEN is unset", async () => {
    delete process.env.REDHAT_TOKEN;
    const calls = stubFetch(() => json({ response: { docs: [] } }));
    await lib.kcsSearch("kernel", { rows: 5, fq: ['documentKind:"Solution"', 'product:"RHEL"'] });
    assert.equal(calls.length, 1);
    const url = new URL(calls[0].url);
    assert.equal(url.origin + url.pathname, lib.KCS_BASE);
    assert.equal(url.searchParams.get("rows"), "5");
    assert.deepEqual(url.searchParams.getAll("fq"), ['documentKind:"Solution"', 'product:"RHEL"']);
    assert.equal(calls[0].init.headers.Authorization, undefined);
    assert.ok(calls[0].init.signal, "request has a timeout signal");
  });

  it("exchanges the token once, caches it, and retries once on 401", async () => {
    process.env.REDHAT_TOKEN = "offline";
    let issued = 0;
    let rejectNext = false;
    const calls = stubFetch((url) => {
      if (url === lib.TOKEN_URL) {
        issued += 1;
        return json({ access_token: `access-${issued}`, expires_in: 900 });
      }
      if (rejectNext) {
        rejectNext = false;
        return json({ error: "revoked" }, 401);
      }
      return json({ response: { docs: [] } });
    });

    await lib.kcsSearch("a");
    await lib.kcsSearch("b");
    assert.equal(issued, 1, "access token is cached");
    assert.equal(calls.at(-1).init.headers.Authorization, "Bearer access-1");

    rejectNext = true;
    await lib.kcsSearch("c");
    assert.equal(issued, 2, "a 401 forces one new token exchange");
    assert.equal(calls.at(-1).init.headers.Authorization, "Bearer access-2");
  });

  it("reports a failed token exchange", async () => {
    process.env.REDHAT_TOKEN = "bad";
    stubFetch(() => json({ error: "invalid_grant" }, 400));
    await assert.rejects(lib.kcsSearch("a"), /Token exchange failed \(400\)/);
  });
});

describe("Security Data API", () => {
  it("encodes the ID into the URL and reports 404 as not found", async () => {
    const calls = stubFetch(() => json({ message: "Not Found" }, 404));
    await assert.rejects(lib.getErratumData("RHSA-2099:99999"), /Advisory RHSA-2099:99999 not found/);
    assert.equal(calls[0].url, `${lib.SECURITY_BASE}/csaf/RHSA-2099%3A99999.json`);
    await assert.rejects(lib.getCveData("CVE-1999-99999"), /CVE-1999-99999 not found/);
  });
});
