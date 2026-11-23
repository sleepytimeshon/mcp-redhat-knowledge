# mcp-redhat-knowledge

An [MCP](https://modelcontextprotocol.io/) server for the Red Hat Knowledge Base API. Lets AI assistants search solutions, articles, documentation, and errata from the Red Hat Customer Portal.

## Tools

| Tool | Description |
|------|-------------|
| `searchKnowledgeBase` | Search KB for solutions and articles by keyword, with optional product and document type filters |
| `getSolution` | Get full content of a KB article by ID (environment, issue, root cause, resolution, diagnostic steps) |
| `searchDocumentation` | Search Red Hat product documentation for how-to guides and best practices |
| `getErrata` | Get errata/advisory details by RHSA/RHBA/RHEA ID (CVEs, severity, affected products) |

All tools accept optional `offset` and `limit` parameters — see [Pagination](#pagination).

## Pagination

All tools accept optional `offset` (default 0) and `limit` (default 30000) parameters to chunk large responses — full KCS articles routinely exceed typical MCP tool-result token caps when returned whole. When a response is truncated, the output ends with a footer like:

```
[truncated: showing chars 0-30000 of 102783. Call again with offset=30000 for the next chunk.]
```

Pass that `offset` back to fetch the next chunk. Small responses return in one call.

## Product Name Aliases

The `searchKnowledgeBase` and `searchDocumentation` tools accept shorthand product names that are automatically resolved to the full names used by the KCS API:

| Alias | Resolves To |
|-------|-------------|
| `OpenShift`, `OCP` | Red Hat OpenShift Container Platform |
| `RHEL`, `Enterprise Linux` | Red Hat Enterprise Linux |
| `Ansible`, `AAP` | Red Hat Ansible Automation Platform |
| `Satellite` | Red Hat Satellite |
| `IdM`, `IPA`, `FreeIPA` | Red Hat Enterprise Linux |
| `SSO` | Red Hat Single Sign-On |
| `Keycloak` | Red Hat build of Keycloak |
| `Quay` | Red Hat Quay |
| `ACM` | Red Hat Advanced Cluster Management for Kubernetes |
| `ACS` | Red Hat Advanced Cluster Security for Kubernetes |
| `Service Mesh` | Red Hat OpenShift Service Mesh |
| `Virtualization` | Red Hat OpenShift Virtualization |
| `OpenStack` | Red Hat OpenStack Platform |
| `Ceph` | Red Hat Ceph Storage |
| `Serverless` | Red Hat OpenShift Serverless |
| `Pipelines` | Red Hat OpenShift Pipelines |
| `GitOps` | Red Hat OpenShift GitOps |
| `Logging` | Red Hat OpenShift Logging |

You can also pass the full product name directly if your product is not in this list.

## Prerequisites

- Node.js 18.14.1+
- A Red Hat offline API token ([generate one here](https://access.redhat.com/management/api))

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

The server exchanges your Red Hat offline API token for a short-lived bearer token via Red Hat SSO. Tokens are cached and refreshed automatically. The `getErrata` tool uses the public Security Data API and does not require authentication.

## Related MCP Servers

- [mcp-redhat-account](https://github.com/sleepytimeshon/mcp-redhat-account) - Account management
- [mcp-redhat-manpage](https://github.com/sleepytimeshon/mcp-redhat-manpage) - RHEL man pages
- [mcp-redhat-subscription](https://github.com/sleepytimeshon/mcp-redhat-subscription) - Subscription management
- [mcp-redhat-support](https://github.com/sleepytimeshon/mcp-redhat-support) - Support case management

## License

MIT
