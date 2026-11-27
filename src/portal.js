// Load full documents from the pages Red Hat serves to browsers. Knowledge Base solutions and
// articles (access.redhat.com/solutions|articles/<id>) and product documentation
// (docs.redhat.com) are Nuxt apps that embed the rendered document as a structured record in
// their __NUXT_DATA__ payload; no Red Hat API serves solution bodies, so this is the only source.
//
// Knowledge Base pages need a subscribed login: the access token from REDHAT_TOKEN is sent as
// the portal's rh_jwt session cookie, to access.redhat.com only, never across a redirect to
// another host. The payload also carries the caller's own account data (userData, auth); the
// decoder walks straight to the content record and never reads those entries.
//
// docs.redhat.com's bot filter rejects unrecognized clients (including an honest
// "mcp-redhat-knowledge" User-Agent) with 403, so requests there use a curl-style User-Agent
// that still names this server. robots.txt disallows /html-single/, so those URLs are refused.

import { fetchWithTimeout, getAccessToken } from "./lib.js";

export const PORTAL_HOST = "access.redhat.com";
export const DOCS_HOST = "docs.redhat.com";
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const DOCS_USER_AGENT = "curl/8.12.1 (compatible; mcp-redhat-knowledge)";
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_SIZE = 20;

// Keep recently loaded documents so paging through one with `offset` does not refetch it
const cache = new Map();

async function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await load();
  cache.delete(key);
  cache.set(key, { at: Date.now(), value });
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  return value;
}

export function clearDocumentCache() {
  cache.clear();
}

// --- Nuxt payload (devalue format) ---

export function readNuxtPayload(html) {
  const m = html.match(/<script[^>]*\bid="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

const WRAPPERS = new Set(["Reactive", "ShallowReactive", "Ref", "ShallowRef", "EmptyRef", "EmptyShallowRef"]);
const SPECIAL = { [-1]: undefined, [-2]: undefined, [-3]: Number.NaN, [-4]: Infinity, [-5]: -Infinity, [-6]: -0 };

// Follow Vue reactivity wrappers to the index of the underlying value
function unwrapIndex(arr, i) {
  let index = i;
  for (let n = 0; n < 32 && Number.isInteger(index) && index >= 0; n += 1) {
    const v = arr[index];
    if (Array.isArray(v) && typeof v[0] === "string" && WRAPPERS.has(v[0])) index = v[1];
    else return index;
  }
  return index;
}

// The plain object at index i, with its values still as indices (no hydration)
export function objectAt(arr, i) {
  if (!Number.isInteger(i) || i < 0) return null;
  const v = arr[unwrapIndex(arr, i)];
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}

// Fully decode the value at index i
export function hydrate(arr, i, memo = new Map()) {
  if (i < 0) return SPECIAL[i];
  if (memo.has(i)) return memo.get(i);
  const v = arr[i];
  if (v === null || typeof v !== "object") return v;

  if (Array.isArray(v)) {
    if (typeof v[0] === "string") {
      const [type, ...rest] = v;
      if (WRAPPERS.has(type)) return rest.length ? hydrate(arr, rest[0], memo) : undefined;
      if (type === "Date") return rest[0];
      if (type === "Set") return rest.map((x) => hydrate(arr, x, memo));
      if (type === "Map") {
        const out = {};
        for (let k = 0; k < rest.length; k += 2) out[String(hydrate(arr, rest[k], memo))] = hydrate(arr, rest[k + 1], memo);
        return out;
      }
      if (type === "null") {
        const out = {};
        for (let k = 0; k < rest.length; k += 2) out[rest[k]] = hydrate(arr, rest[k + 1], memo);
        return out;
      }
      return Number.isInteger(rest[0]) ? hydrate(arr, rest[0], memo) : rest[0];
    }
    const out = [];
    memo.set(i, out);
    for (const x of v) out.push(hydrate(arr, x, memo));
    return out;
  }

  const out = {};
  memo.set(i, out);
  for (const [k, x] of Object.entries(v)) out[k] = hydrate(arr, x, memo);
  return out;
}

// The entries of the payload's `data` object, as [key, index] pairs
function dataEntries(arr) {
  const root = objectAt(arr, 0);
  const data = root && objectAt(arr, root.data);
  return data ? Object.entries(data) : [];
}

// --- Fetching ---

// GET an https page, following redirects only between the allowed hosts. The cookie goes only
// to access.redhat.com.
async function fetchPage(url, { hosts, cookie }) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const u = new URL(current);
    if (u.protocol !== "https:" || !hosts.includes(u.host)) {
      throw new Error(`Refusing to load ${u.origin}: only ${hosts.join(", ")} are allowed`);
    }
    const headers = { Accept: "text/html" };
    if (cookie && u.host === PORTAL_HOST) headers.Cookie = cookie;
    if (u.host === DOCS_HOST) headers["User-Agent"] = DOCS_USER_AGENT;
    const res = await fetchWithTimeout(u.href, { headers, redirect: "manual" });
    if (REDIRECTS.has(res.status) && res.headers.get("location")) {
      current = new URL(res.headers.get("location"), u).href;
      continue;
    }
    return { res, url: u.href };
  }
  throw new Error(`Too many redirects loading ${url}`);
}

// --- Knowledge Base solutions and articles ---

export class KbaseUnavailable extends Error {}

// Load a Knowledge Base solution or article by numeric ID. Returns the record, null when the ID
// does not exist, or throws KbaseUnavailable when the page did not include the record.
export async function getKbaseRecord(id) {
  if (!/^\d+$/.test(id)) throw new KbaseUnavailable(`"${id}" is not a numeric Knowledge Base ID`);
  const token = await getAccessToken();
  if (!token) throw new KbaseUnavailable("REDHAT_TOKEN is not set");
  return cached(`kb:${id}`, () => loadKbaseRecord(id, token));
}

async function loadKbaseRecord(id, token) {

  const { res, url } = await fetchPage(`https://${PORTAL_HOST}/kb/${id}`, { hosts: [PORTAL_HOST], cookie: `rh_jwt=${token}` });
  if (res.status === 404) return null;
  if (!res.ok) throw new KbaseUnavailable(`the Customer Portal answered ${res.status}`);

  const arr = readNuxtPayload(await res.text());
  if (!arr) throw new KbaseUnavailable("the Customer Portal page carried no document record (the page format may have changed)");

  for (const [key, index] of dataEntries(arr)) {
    if (key !== `content-${id}`) continue;
    const record = objectAt(arr, index);
    if (record && Number.isInteger(record.kbase)) {
      const kbase = hydrate(arr, record.kbase);
      // The portal renders an empty record for an ID that does not exist
      if (!kbase?.title) return null;
      return { ...kbase, pageUrl: url };
    }
  }
  throw new KbaseUnavailable("the Customer Portal page carried no record for this ID (the login may have been rejected)");
}

// --- docs.redhat.com ---

const DOCS_PATH = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?documentation\//i;

// Accept a docs.redhat.com URL (or a legacy access.redhat.com/documentation URL) and return it normalized
export function normalizeDocsUrl(input) {
  let u;
  try {
    u = new URL(String(input).trim());
  } catch {
    throw new Error(`Invalid documentation URL "${input}": expected an https://docs.redhat.com/... URL from searchDocumentation`);
  }
  if (u.protocol !== "https:" || ![DOCS_HOST, PORTAL_HOST].includes(u.host) || !DOCS_PATH.test(u.pathname)) {
    throw new Error(`Invalid documentation URL "${input}": expected an https://docs.redhat.com/.../documentation/... URL`);
  }
  if (/\/html-single\//.test(u.pathname)) {
    throw new Error(`"${input}" is a single-page guide (/html-single/), which docs.redhat.com's robots.txt disallows. Use the /html/ chapter URL that searchDocumentation returns instead.`);
  }
  if (u.host === PORTAL_HOST) u.host = DOCS_HOST;
  u.search = "";
  return u;
}

// Load a docs.redhat.com page's document record: { name, html, productName, breadcrumbs, toc, pagination, ... }
export async function getDocsRecord(input) {
  const target = normalizeDocsUrl(input);
  const fragment = decodeURIComponent(target.hash.slice(1));
  target.hash = "";
  const doc = await cached(`docs:${target.href}`, () => loadDocsRecord(target));
  return doc && { ...doc, fragment };
}

async function loadDocsRecord(target) {

  const { res, url } = await fetchPage(target.href, { hosts: [DOCS_HOST, PORTAL_HOST] });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`docs.redhat.com answered ${res.status} for ${target.href}`);

  const arr = readNuxtPayload(await res.text());
  if (!arr) throw new Error("The documentation page carried no document record (the page format may have changed)");

  for (const [, index] of dataEntries(arr)) {
    const record = objectAt(arr, index);
    if (record && "html" in record && "toc" in record) {
      const doc = hydrate(arr, index);
      if (typeof doc.html === "string" && doc.html) return { ...doc, pageUrl: url };
    }
  }
  throw new Error("The documentation page carried no document content (the page format may have changed)");
}
