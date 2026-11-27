#!/usr/bin/env node
// Offline tests of the HTML converter (src/html.js), the Nuxt page loader (src/portal.js), and
// the full-document formatters, against synthetic pages and a stubbed fetch. The fixtures are
// made up: real Knowledge Base text is subscriber content and must not be committed.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { htmlToMarkdown, convertHtml, decodeEntities } from "../src/html.js";
import * as lib from "../src/lib.js";
import * as portal from "../src/portal.js";

const realFetch = globalThis.fetch;
const realToken = process.env.REDHAT_TOKEN;

beforeEach(() => portal.clearDocumentCache());
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realToken === undefined) delete process.env.REDHAT_TOKEN;
  else process.env.REDHAT_TOKEN = realToken;
  lib.clearTokenCache();
});

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return calls;
}

// Encode a value the way Nuxt's devalue does: a flat array whose entries reference each other by index
function devalue(value) {
  const arr = [];
  const put = (v) => {
    const i = arr.length;
    arr.push(null);
    if (v === null || typeof v !== "object") arr[i] = v;
    else if (Array.isArray(v)) arr[i] = v.map(put);
    else arr[i] = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, put(x)]));
    return i;
  };
  arr.push(["ShallowReactive", 1]);
  put(value);
  return arr;
}

const page = (payload) =>
  `<!doctype html><html><body><div id="__nuxt">rendered</div><script type="application/json" data-nuxt-data="nuxt-app" data-ssr="true" id="__NUXT_DATA__">${JSON.stringify(payload)}</script></body></html>`;

const html = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { "Content-Type": "text/html", ...headers } });

const token = (url) =>
  url === lib.TOKEN_URL ? new Response(JSON.stringify({ access_token: "access-1", expires_in: 900 }), { status: 200 }) : null;

describe("htmlToMarkdown", () => {
  it("renders headings, paragraphs, emphasis, inline code, and links", () => {
    const md = htmlToMarkdown('<h2>Title</h2><p>Run <code>kdumpctl&nbsp;restart</code> as <strong>root</strong>, see <a href="/kb/1">this</a>.</p>');
    assert.equal(md, "## Title\n\nRun `kdumpctl restart` as **root**, see [this](https://access.redhat.com/kb/1).");
  });

  it("keeps code blocks verbatim, including markup inside them", () => {
    const md = htmlToMarkdown('<pre class="language-bash"><code># <strong>systemctl</strong> restart kdump\n  indented &lt;line&gt;</code></pre>');
    assert.equal(md, "```bash\n# systemctl restart kdump\n  indented <line>\n```");
  });

  it("nests lists and indents their code blocks", () => {
    const md = htmlToMarkdown("<ol><li><p>Edit the file:</p><pre>a\n  b</pre><ul><li>inner</li></ul></li><li>Second</li></ol>");
    assert.equal(md, "1. Edit the file:\n\n   ```\n   a\n     b\n   ```\n\n   - inner\n2. Second");
  });

  it("renders tables and escapes pipes", () => {
    const md = htmlToMarkdown("<table><thead><tr><th>Old</th><th>New</th></tr></thead><tbody><tr><td>/rs/a</td><td>a|b</td></tr></tbody></table>");
    assert.equal(md, "| Old | New |\n| --- | --- |\n| /rs/a | a\\|b |");
  });

  it("renders docs.redhat.com admonitions, definition lists, and block titles", () => {
    const md = htmlToMarkdown(
      '<p class="title"><strong>Procedure</strong></p><rh-alert class="admonition note" state="info"><div class="admonition_header" slot="header">Note</div><div><p>Reboot after.</p></div></rh-alert><dl><dt><code>halt</code></dt><dd>Stops the system.</dd></dl>',
    );
    assert.equal(md, "**Procedure**\n\n> **Note:** Reboot after.\n\n- **`halt`**\n  Stops the system.");
  });

  it("drops page chrome such as copy-link tooltips and icons", () => {
    const md = htmlToMarkdown('<h2 class="title"><a href="#s1">15.1. Size</a><rh-tooltip class="copy-link-tooltip"><div class="section-link">Copy link</div></rh-tooltip></h2><script>alert(1)</script><p>Body</p>');
    assert.equal(md, "## 15.1. Size\n\nBody");
  });

  it("demotes headings and resolves links against a base", () => {
    assert.equal(htmlToMarkdown("<h2>Workaround</h2>", { headingShift: 1 }), "### Workaround");
    assert.equal(htmlToMarkdown('<a href="other">x</a>', { base: "https://docs.redhat.com/en/documentation/a/b/html/c/index" }), "[x](https://docs.redhat.com/en/documentation/a/b/html/c/other)");
  });

  it("extracts one element by id", () => {
    const src = '<section id="a"><h2>A</h2><p>one</p></section><section id="b"><h2>B</h2><p>two</p></section>';
    assert.deepEqual(convertHtml(src, { fragment: "b" }), { markdown: "## B\n\ntwo", fragmentFound: true });
    assert.equal(convertHtml(src, { fragment: "zz" }).fragmentFound, false);
  });

  it("decodes named and numeric entities", () => {
    assert.equal(decodeEntities("&lt;a&gt; &amp; &#39;b&#39; &#x2014; &hellip;"), "<a> & 'b' — …");
  });
});

describe("Nuxt payload decoding", () => {
  it("hydrates references, wrappers, and special values", () => {
    const arr = [["ShallowReactive", 1], { data: 2 }, ["Reactive", 3], { list: 4, when: 7, gone: -1 }, [5, 6], "a", "b", ["Date", "2026-01-01T00:00:00.000Z"]];
    assert.deepEqual(portal.hydrate(arr, 0), { data: { list: ["a", "b"], when: "2026-01-01T00:00:00.000Z", gone: undefined } });
  });

  it("reads the payload from a page", () => {
    assert.deepEqual(portal.readNuxtPayload(page([1, 2])), [1, 2]);
    assert.equal(portal.readNuxtPayload("<html>no payload</html>"), null);
  });
});

const SOLUTION = {
  data: {
    auth: { email: "SECRET-USER@example.com" },
    "content-123": {
      kbase: {
        id: 123,
        title: "Service fails after update",
        type: "solution",
        updated: "2026-03-22T14:51:19.000Z",
        kcsState: "verified",
        environment: "<ul><li>Red Hat Enterprise Linux 9</li></ul>",
        issue: "<p>The service fails.</p>",
        resolution: "<p>Update to <code>pkg-2.0</code>.</p><h2>Workaround:</h2><p>Restart it.</p>",
        rootCause: "<p>A regression.</p>",
        diagnosticSteps: "<pre><code>journalctl -u svc</code></pre>",
        body: null,
        products: [{ name: "Red Hat Enterprise Linux" }],
        sbr: [{ name: "Kernel" }],
        attachments: [],
        insightsUrl: "",
      },
      userData: { name: "SECRET-USER", account: "SECRET-ACCOUNT" },
    },
  },
};

describe("getKbaseRecord", () => {
  it("needs REDHAT_TOKEN", async () => {
    delete process.env.REDHAT_TOKEN;
    await assert.rejects(portal.getKbaseRecord("123"), (err) => err instanceof portal.KbaseUnavailable && /REDHAT_TOKEN is not set/.test(err.message));
  });

  it("rejects non-numeric IDs before any request", async () => {
    process.env.REDHAT_TOKEN = "offline";
    const calls = stubFetch(() => html("x"));
    await assert.rejects(portal.getKbaseRecord("../etc"), portal.KbaseUnavailable);
    assert.equal(calls.length, 0);
  });

  it("loads the record with the access token as the portal session cookie, without reading account data", async () => {
    process.env.REDHAT_TOKEN = "offline";
    const calls = stubFetch((url) => token(url) || html(page(devalue(SOLUTION))));
    const record = await portal.getKbaseRecord("123");
    const pageCall = calls.find((c) => c.url.includes("/kb/123"));
    assert.equal(pageCall.url, "https://access.redhat.com/kb/123");
    assert.equal(pageCall.init.headers.Cookie, "rh_jwt=access-1");
    assert.equal(pageCall.init.redirect, "manual");
    assert.equal(record.title, "Service fails after update");
    assert.doesNotMatch(JSON.stringify(record), /SECRET/);

    const out = lib.formatKbaseRecord(record);
    assert.match(out, /^# Service fails after update\n\*\*ID:\*\* 123\n\*\*Type:\*\* Solution \(verified\)\n\*\*URL:\*\* https:\/\/access\.redhat\.com\/solutions\/123/);
    assert.match(out, /## Environment\n- Red Hat Enterprise Linux 9\n\n## Issue\nThe service fails\.\n\n## Resolution\nUpdate to `pkg-2\.0`\.\n\n### Workaround:\n\nRestart it\.\n\n## Root Cause\nA regression\.\n\n## Diagnostic Steps\n```\njournalctl -u svc\n```/);
    assert.doesNotMatch(out, /SECRET|no resolution/);
  });

  it("caches records so paging does not refetch", async () => {
    process.env.REDHAT_TOKEN = "offline";
    const calls = stubFetch((url) => token(url) || html(page(devalue(SOLUTION))));
    await portal.getKbaseRecord("123");
    await portal.getKbaseRecord("123");
    assert.equal(calls.filter((c) => c.url.includes("/kb/")).length, 1);
  });

  it("returns null for a missing ID and for an empty record", async () => {
    process.env.REDHAT_TOKEN = "offline";
    stubFetch((url) => token(url) || html("not found", 404));
    assert.equal(await portal.getKbaseRecord("404"), null);
    stubFetch((url) => token(url) || html(page(devalue({ data: { "content-9": { kbase: { title: null } } } }))));
    assert.equal(await portal.getKbaseRecord("9"), null);
  });

  it("reports a page without a record as unavailable", async () => {
    process.env.REDHAT_TOKEN = "offline";
    stubFetch((url) => token(url) || html("<html>login</html>"));
    await assert.rejects(portal.getKbaseRecord("123"), portal.KbaseUnavailable);
  });

  it("never follows a redirect to another host with the cookie", async () => {
    process.env.REDHAT_TOKEN = "offline";
    const calls = stubFetch((url) => token(url) || html("", 302, { Location: "https://sso.example.com/login" }));
    await assert.rejects(portal.getKbaseRecord("123"), /Refusing to load https:\/\/sso\.example\.com/);
    assert.equal(calls.filter((c) => !c.url.startsWith(lib.TOKEN_URL)).length, 1);
  });

  it("formats an article body and flags a solution without a resolution", () => {
    const article = lib.formatKbaseRecord({ id: 7, title: "Guide", type: "article", articleType: "General", body: "<h2>Background</h2><p>Text.</p>" });
    assert.match(article, /\*\*Type:\*\* Article \(General\)\n\*\*URL:\*\* https:\/\/access\.redhat\.com\/articles\/7\n\n## Background\n\nText\./);
    const gated = lib.formatKbaseRecord({ id: 8, title: "Gated", type: "solution", issue: "<p>Issue.</p>" });
    assert.match(gated, /returned no resolution for this solution/);
  });
});

const DOC_URL = "https://docs.redhat.com/en/documentation/rhel/9/html/guide/chapter-two";
const DOCS = {
  data: {
    hash1: { unrelated: true },
    hash2: {
      name: "Chapter 2. Configuring things",
      html: '<section class="chapter" id="chapter-two"><p>Intro.</p><section class="section" id="part-a"><h2 class="title">2.1. Part A</h2><p>Alpha.</p></section></section>',
      toc: [
        { title: "Guide", url: "/documentation/rhel/9/html/guide/index", visible: true },
        { title: "1. One", url: "/documentation/rhel/9/html/guide/chapter-one", visible: true },
        { title: "2. Configuring things", url: "/documentation/rhel/9/html/guide/chapter-two", visible: true },
        { title: "3. Three", url: "/documentation/rhel/9/html/guide/chapter-three", visible: true },
      ],
      title: { name: "Guide", productVersion: { name: "9" } },
      productName: "Red Hat Enterprise Linux",
      productVersions: [{ name: "10" }, { name: "9" }],
      locale: "en-us",
    },
  },
};

describe("getDocsRecord", () => {
  it("accepts only docs.redhat.com documentation URLs and refuses /html-single/", () => {
    assert.equal(portal.normalizeDocsUrl(`${DOC_URL}?x=1`).href, DOC_URL);
    assert.equal(portal.normalizeDocsUrl("https://access.redhat.com/documentation/en-us/rhel/9/html/guide/index").host, "docs.redhat.com");
    assert.throws(() => portal.normalizeDocsUrl("https://example.com/en/documentation/x"), /Invalid documentation URL/);
    assert.throws(() => portal.normalizeDocsUrl("http://docs.redhat.com/en/documentation/x"), /Invalid documentation URL/);
    assert.throws(() => portal.normalizeDocsUrl("https://docs.redhat.com/en/products"), /Invalid documentation URL/);
    assert.throws(() => portal.normalizeDocsUrl("https://docs.redhat.com/en/documentation/rhel/9/html-single/guide/index"), /robots\.txt disallows/);
  });

  it("fetches with the docs User-Agent, no cookie, and formats with navigation", async () => {
    process.env.REDHAT_TOKEN = "offline";
    const calls = stubFetch(() => html(page(devalue(DOCS))));
    const doc = await portal.getDocsRecord(DOC_URL);
    assert.equal(calls.length, 1);
    assert.match(calls[0].init.headers["User-Agent"], /^curl\/\S+ \(compatible; mcp-redhat-knowledge\)$/);
    assert.equal(calls[0].init.headers.Cookie, undefined);

    const out = lib.formatDocsRecord(doc);
    assert.match(out, /^# Chapter 2\. Configuring things\n\*\*Guide:\*\* Guide \(Red Hat Enterprise Linux 9\)\n\*\*URL:\*\* https:\/\/docs\.redhat\.com\/en\/documentation\/rhel\/9\/html\/guide\/chapter-two\n\*\*Product versions with documentation:\*\* 10, 9/);
    assert.match(out, /Intro\.\n\n## 2\.1\. Part A\n\nAlpha\./);
    assert.match(out, /## Navigation\n- Previous: \[1\. One\]\(https:\/\/docs\.redhat\.com\/en\/documentation\/rhel\/9\/html\/guide\/chapter-one\)\n- Next: \[3\. Three\]/);
    assert.doesNotMatch(out, /## Chapters/);
  });

  it("limits the output to a #fragment and reuses the cached page", async () => {
    const calls = stubFetch(() => html(page(devalue(DOCS))));
    const whole = await portal.getDocsRecord(DOC_URL);
    const part = await portal.getDocsRecord(`${DOC_URL}#part-a`);
    assert.equal(calls.length, 1);
    assert.equal(whole.fragment, "");
    const out = lib.formatDocsRecord(part);
    assert.match(out, /Showing only section "#part-a"/);
    assert.doesNotMatch(out, /Intro\./);
    assert.match(lib.formatDocsRecord({ ...part, fragment: "nope" }), /Section "#nope" was not found/);
  });

  it("returns null for a missing page", async () => {
    stubFetch(() => html("gone", 404));
    assert.equal(await portal.getDocsRecord(DOC_URL), null);
  });
});
