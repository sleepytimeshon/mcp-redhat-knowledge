# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] - 2026-11-27

### Added
- `getDocumentation` tool: the full text of a docs.redhat.com chapter, or one `#section` of it, as Markdown with procedures, commands, and notes intact, plus previous/next chapter links and the chapter list on a guide's index page.
- `getSolution` returns full solutions (environment, issue, resolution, root cause, and diagnostic steps) and full article bodies when `REDHAT_TOKEN` is set, by loading the document from the Customer Portal page; no Red Hat API serves solution bodies.
- Search results end with a line naming the tool that reads each kind of result in full; `getSolution` redirects advisory IDs and documentation URLs to `getErrata` and `getDocumentation`.
- `searchErrata` tool: find advisories by CVE, package, or keyword, newest first, with optional product, severity, and advisory type filters.
- `getCve` tool: Red Hat's assessment of a CVE (severity, CVSS, details, statement, mitigation, fixing advisories and packages per product, and the state of other products) from the public Security Data API.
- `maxResults` on `searchDocumentation`.
- Offline tests of the helpers, formatters, HTML conversion, and page loading (`test/unit.mjs`, `test/portal.mjs`), run by `npm test`.

### Changed
- `REDHAT_TOKEN` is optional: without it, search tools query the Knowledge Base anonymously.
- Without a token, `getSolution` returns the search index's issue and summary and names the sections it could not include. Previously it omitted them silently with a token and printed the literal `subscriber_only` without one.
- Search results show the total match count and each result's products, give absolute Customer Portal URLs, and trim abstracts to 300 characters.
- `documentType` is case-insensitive.
- Every Red Hat API request times out after 30 seconds, and a rejected cached access token is exchanged again once.
- API clients, helpers, and formatters moved to `src/lib.js`; HTML-to-Markdown conversion is in `src/html.js` and page loading in `src/portal.js`.

### Fixed
- `getSolution` returned an unrelated document when the requested ID did not exist (for example, `3138` returned CVE-2015-3138); it now matches the ID exactly, only against solutions and articles, and prefers the English original over translations.
- `getErrata` omitted the advisory's description, and listed per-architecture package builds under "Affected Products"; it now shows the details, the product names, and the fixed packages.
- `getErrata` accepts lowercase IDs and rejects malformed ones before calling the API.
- `maxResults` rejects non-integers, which the API answered with a 400.
- A double quote in a `product` or `documentType` value no longer breaks the search query.
- Documentation results showed "Untitled".
- Tool descriptions claimed a default OpenShift product filter that was never applied, and described `offset` in bytes instead of characters.
- README product alias table lacked Directory Server, Certificate System, Data Grid, and AMQ.

## [1.2.2] - 2026-11-23

### Added
- This changelog, included in the published package.

### Security
- Upgrade `@modelcontextprotocol/sdk` to 1.32.2 and `zod` to 4.6.7, and refresh the lockfile, clearing every `npm audit` advisory (1 critical, 8 high, 2 moderate) in the SDK, zod, and their transitive dependencies.

## [1.2.1] - 2026-11-23

### Added
- Continuous integration on Node.js 18, 20, 22, and 24 for every push and pull request to `main`, with a stdio smoke test that checks the registered tools against the README and the reported server version against `package.json`.
- Automated npm publishing with provenance through npm trusted publishing, plus a GitHub release for each version.
- `engines.node` declares the supported Node.js range (18.14.1 or later).
- README sections on pagination, version pinning, and the release process.

### Changed
- The published package contains only `src/`, `README.md`, `LICENSE`, and `package.json`.

### Fixed
- README setup for Claude Code (MCP servers belong in `~/.claude.json` or `.mcp.json`, not `settings.json`), VS Code (`servers` key and `${env:...}` variables), and Cursor, now documented separately.
- The `bin` path no longer uses a `./` prefix, which npm 11 drops on publish.

## [1.2.0] - 2026-05-06

### Added
- Optional `offset` and `limit` parameters on all four tools split large responses, such as full KCS articles, into chunks; truncated responses end with a footer giving the next `offset`.

### Fixed
- The server reports its package version; earlier releases reported 0.1.0.

## [1.1.4] - 2026-03-20

### Changed
- Repository and issue URLs point to the `sleepytimeshon` GitHub account after the repository transfer.

## [1.1.3] - 2026-03-12

### Changed
- README lists `mcp-redhat-manpage` under Related MCP Servers, in a standard order across all servers.

## [1.1.2] - 2026-03-10

### Added
- README configuration for Gemini CLI, a Related MCP Servers section, and guidance on supplying `REDHAT_TOKEN` through a secrets manager.

## [1.1.1] - 2026-03-08

### Added
- First public release: an MCP server for the Red Hat Knowledge Base with `searchKnowledgeBase`, `getSolution`, `searchDocumentation`, and `getErrata`, including product name aliases for search filters and tool annotations.

[Unreleased]: https://github.com/sleepytimeshon/mcp-redhat-knowledge/compare/v1.3.0...HEAD
[1.3.0]: https://www.npmjs.com/package/mcp-redhat-knowledge/v/1.3.0
[1.2.2]: https://www.npmjs.com/package/mcp-redhat-knowledge/v/1.2.2
[1.2.1]: https://www.npmjs.com/package/mcp-redhat-knowledge/v/1.2.1
[1.2.0]: https://www.npmjs.com/package/mcp-redhat-knowledge/v/1.2.0
[1.1.4]: https://www.npmjs.com/package/mcp-redhat-knowledge/v/1.1.4
[1.1.3]: https://www.npmjs.com/package/mcp-redhat-knowledge/v/1.1.3
[1.1.2]: https://www.npmjs.com/package/mcp-redhat-knowledge/v/1.1.2
[1.1.1]: https://www.npmjs.com/package/mcp-redhat-knowledge/v/1.1.1
