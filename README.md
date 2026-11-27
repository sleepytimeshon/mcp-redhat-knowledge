# mcp-redhat-knowledge

An [MCP](https://modelcontextprotocol.io/) server for the Red Hat Knowledge Base, product documentation, and security data. Lets AI assistants search and read full solutions, articles, documentation chapters, errata, and CVEs from the Red Hat Customer Portal and docs.redhat.com.

## Tools

| Tool | Description |
|------|-------------|
| `searchKnowledgeBase` | Search KB for solutions and articles by keyword, with optional product and document type filters |
| `getSolution` | Get the full text of a KB solution (environment, issue, resolution, root cause, diagnostic steps) or article by ID; needs `REDHAT_TOKEN` |
| `searchDocumentation` | Search Red Hat product documentation for how-to guides and best practices |
| `getDocumentation` | Get the full text of a docs.redhat.com chapter (or one `#section`) with previous/next chapter links |
| `searchErrata` | Search advisories by CVE, package, or keyword, newest first, with optional product, severity, and type filters |
| `getErrata` | Get errata/advisory details by RHSA/RHBA/RHEA ID (severity, CVEs, details, affected products, fixed packages) |
| `getCve` | Get Red Hat's CVE assessment (severity, CVSS, statement, mitigation, fixing advisories per product) |

All tools accept optional `offset` and `limit` parameters — see [Pagination](#pagination). `searchKnowledgeBase`, `searchDocumentation`, and `searchErrata` accept `maxResults` (1-50, default 10).

`documentType` is case-insensitive and accepts `Solution`, `Article`, `Documentation`, `Errata`, `Cve`, `Vulnerability`, or `Discussion` (other index kinds pass through unchanged).

## Pagination

All tools accept optional `offset` (default 0) and `limit` (default 30000) parameters, counted in characters of rendered output, to chunk large responses — full solutions and documentation chapters routinely exceed typical MCP tool-result token caps when returned whole. When a response is truncated, the output ends with a footer like:

```
[truncated: showing chars 0-30000 of 102783. Call again with offset=30000 for the next chunk.]
```

Pass that `offset` back to fetch the next chunk. Small responses return in one call. `getSolution` and `getDocumentation` keep recently loaded documents in memory for 10 minutes, so paging through one does not reload it.

## Output

Tool output is Markdown written for a language model: documents keep their headings, lists, tables, code blocks, links, and notes; page chrome is dropped. Search results end with a line naming the tool that reads each kind of result in full. When a tool returns less than the full document, its output says what is missing and why.

## Product Name Aliases

The `searchKnowledgeBase`, `searchDocumentation`, and `searchErrata` tools accept shorthand product names that are automatically resolved to the full names used by the KCS API:

| Alias | Resolves To |
|-------|-------------|
| `OpenShift`, `OCP` | Red Hat OpenShift Container Platform |
| `RHEL`, `Enterprise Linux` | Red Hat Enterprise Linux |
| `Ansible`, `AAP` | Red Hat Ansible Automation Platform |
| `Satellite` | Red Hat Satellite |
| `IdM`, `IPA`, `FreeIPA` | Red Hat Enterprise Linux (IdM ships with RHEL; pass `Red Hat Identity Management` to narrow) |
| `Directory Server` | Red Hat Directory Server |
| `Certificate System` | Red Hat Certificate System |
| `SSO` | Red Hat Single Sign-On |
| `Keycloak` | Red Hat build of Keycloak |
| `Quay` | Red Hat Quay |
| `ACM` | Red Hat Advanced Cluster Management for Kubernetes |
| `ACS` | Red Hat Advanced Cluster Security for Kubernetes |
| `Service Mesh` | Red Hat OpenShift Service Mesh |
| `Virtualization` | Red Hat OpenShift Virtualization (pass `Red Hat Virtualization` for RHV) |
| `OpenStack` | Red Hat OpenStack Platform |
| `Ceph` | Red Hat Ceph Storage |
| `Data Grid` | Red Hat Data Grid |
| `AMQ` | Red Hat AMQ |
| `Serverless` | Red Hat OpenShift Serverless |
| `Pipelines` | Red Hat OpenShift Pipelines |
| `GitOps` | Red Hat OpenShift GitOps |
| `Logging` | Red Hat OpenShift Logging |

You can also pass the full product name directly if your product is not in this list. No product filter is applied unless you pass one. `searchErrata` matches the product as a prefix of the advisory's product names, so `RHEL` also matches `Red Hat Enterprise Linux for x86_64`.

## Prerequisites

- Node.js 18.14.1+
- Optional: a Red Hat offline API token ([generate one here](https://access.redhat.com/management/api)) for a subscribed account, needed for the full text of Knowledge Base solutions and articles

## Configuration

Set your Red Hat offline API token in your shell profile:

```bash
export REDHAT_TOKEN="your-offline-token-here"
```

In enterprise environments, provide `REDHAT_TOKEN` through your secrets management solution (e.g. HashiCorp Vault, Kubernetes secrets, or your CI platform's secret variables) rather than shell profiles.

The offline token expires if it is not used for 30 days; generate a new one from the same page if authentication starts failing.

### Pinning a version

The examples below run `npx -y mcp-redhat-knowledge`, which fetches the latest published release each time the server starts. For operational use, pin a version so upgrades happen deliberately:

- Replace `mcp-redhat-knowledge` in `args` with `mcp-redhat-knowledge@<version>` (e.g. `mcp-redhat-knowledge@1.2.0`), or
- Install it once with `npm install -g mcp-redhat-knowledge@<version>` and use `mcp-redhat-knowledge` as the `command` with no `args`.

### Gemini CLI

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "redhat-knowledge": {
      "command": "npx",
      "args": ["-y", "mcp-redhat-knowledge"],
      "env": {
        "REDHAT_TOKEN": "$REDHAT_TOKEN"
      }
    }
  }
}
```

### watsonx Orchestrate

```bash
# Add a connection for the Red Hat API token
orchestrate connections add --app-id "redhat-knowledge"
orchestrate connections configure --app-id redhat-knowledge --env draft --kind key_value --type team --url "https://access.redhat.com"
orchestrate connections set-credentials --app-id "redhat-knowledge" --env draft -e REDHAT_TOKEN=your-offline-token-here

# Import the MCP toolkit
orchestrate toolkits import --kind mcp \
  --name redhat-knowledge \
  --description "Red Hat Knowledge Base" \
  --command "npx -y mcp-redhat-knowledge" \
  --tools "*" \
  --app-id redhat-knowledge
```

### Claude Code

Claude Code reads MCP servers from `~/.claude.json` (user and local scopes) or a project's `.mcp.json`, not from `settings.json`.

To make the server available in every project, add it at user scope:

```bash
claude mcp add redhat-knowledge --scope user \
  -e REDHAT_TOKEN="$REDHAT_TOKEN" \
  -- npx -y mcp-redhat-knowledge
```

This stores the token's value in `~/.claude.json`. To keep the token out of configuration files, add the server to a project's `.mcp.json` instead; Claude Code expands `${REDHAT_TOKEN}` from the environment when it starts the server:

```json
{
  "mcpServers": {
    "redhat-knowledge": {
      "command": "npx",
      "args": ["-y", "mcp-redhat-knowledge"],
      "env": {
        "REDHAT_TOKEN": "${REDHAT_TOKEN}"
      }
    }
  }
}
```

Run `claude mcp list` to confirm the server connects.

### VS Code

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "redhat-knowledge": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-redhat-knowledge"],
      "env": {
        "REDHAT_TOKEN": "${env:REDHAT_TOKEN}"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your workspace, or `~/.cursor/mcp.json` for all workspaces:

```json
{
  "mcpServers": {
    "redhat-knowledge": {
      "command": "npx",
      "args": ["-y", "mcp-redhat-knowledge"],
      "env": {
        "REDHAT_TOKEN": "${env:REDHAT_TOKEN}"
      }
    }
  }
}
```

## Authentication

`REDHAT_TOKEN` is optional. Without it, search tools query the Knowledge Base anonymously and return the same titles, abstracts, and IDs.

`getSolution` needs a token for full text. No Red Hat API returns the body of a Knowledge Base solution: the search index withholds environment, root cause, resolution, and diagnostic steps, and the former Customer Portal solutions API (`/rs/solutions`) has been decommissioned. With `REDHAT_TOKEN` set, `getSolution` loads the solution or article page from access.redhat.com the way a logged-in browser does, sending the access token as the portal's session cookie (to access.redhat.com only), and reads the document from the page. The token's account must have a subscription that covers the content. Without a token, or if the page cannot be read, `getSolution` falls back to the search index's issue and summary and says which sections are missing. The page also carries your own account details; the server never reads them.

This page loading is not a documented Red Hat API, so a Customer Portal change can break it; `getSolution` then falls back to the search index.

`getDocumentation` needs no token. docs.redhat.com rejects unrecognized HTTP clients, so the server identifies itself there as `curl/8.12.1 (compatible; mcp-redhat-knowledge)`. It refuses `/html-single/` URLs, which docs.redhat.com's `robots.txt` disallows; use the per-chapter `/html/` URLs that `searchDocumentation` returns.

With a token, the server exchanges it for a short-lived bearer token via Red Hat SSO. Tokens are cached, refreshed automatically, and exchanged again if the API rejects a cached one. `getErrata` and `getCve` use the public Security Data API and never send a token. Every request times out after 30 seconds.

## Releasing

Every push to `main` runs CI (`.github/workflows/ci.yml`): `npm ci`, a syntax check, and `npm test` on Node 18, 20, 22, and 24. `npm test` starts the server and checks that its tools match the tables in [Tools](#tools) and that it reports the `package.json` version.

To release, bump `version` in both `package.json` and the `McpServer` declaration in `src/index.js`, move the `[Unreleased]` entries in [CHANGELOG.md](CHANGELOG.md) under a heading for the new version, then push to `main`. When that version is not yet on npm, CI publishes it with provenance through npm trusted publishing and creates a `vX.Y.Z` GitHub release. Pushes that keep the version only run the tests.

## Related MCP Servers

- [mcp-redhat-account](https://github.com/sleepytimeshon/mcp-redhat-account) - Account management
- [mcp-redhat-manpage](https://github.com/sleepytimeshon/mcp-redhat-manpage) - RHEL man pages
- [mcp-redhat-subscription](https://github.com/sleepytimeshon/mcp-redhat-subscription) - Subscription management
- [mcp-redhat-support](https://github.com/sleepytimeshon/mcp-redhat-support) - Support case management

## License

MIT
