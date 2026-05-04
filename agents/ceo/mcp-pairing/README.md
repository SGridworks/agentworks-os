# MCP Pairing for Claude Desktop

This document describes how to configure Claude Desktop to connect to the AgentWorks MCP server for dogfood testing.

## Configuration

Place the following JSON snippet in `~/Library/Application Support/Claude/claude_desktop_config.json` under the `mcpServers` key:

```json
{
  "mcpServers": {
    "agentworks": {
      "url": "http://127.0.0.1:7710/api/mcp",
      "mode": "http",
      "authToken": "REPLACE_WITH_REAL_TOKEN"
    }
  }
}
```

* `url` points to the local MCP server endpoint.
* `mode` is set to `http` for HTTP transport (the server currently implements JSON‑RPC over HTTP).
* Replace `authToken` with the secret token provided by the backend engineer once the server is live.

## Smoke Test

After adding the snippet, restart Claude Desktop and run:

```
claude --mcp list
```

You should see `agentworks` listed. Once the server implements the tool bodies, you can call:

```
claude --mcp call tools/list
```

and later:

```
claude --mcp call memory.read {"tenantId":"<your-tenant-id>","key":"some/key"}
```

## Next Steps

1. **Backend**: Implement the four tool bodies (`memory.read`, `memory.write`, `policy.check`, `activity.log`).
2. **Token**: Provide a real authentication token.
3. **Verification**: Run the smoke test above and confirm that tool calls return real data.
