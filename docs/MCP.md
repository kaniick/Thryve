---
type: "Guide"
title: "MCP"
description: "The unit's Model Context Protocol endpoint, tools, and optional access key."
status: "stable"
generated: {"by": "kaniick", "at": "2026-11-17T19:45:00-08:00"}
sources: [{"resource": "/adr/0011-mcp-and-mhs.md", "title": "ADR 0011: MCP tool design and Model Hardware Standard alignment"}, {"resource": "/adr/0012-deployment-and-trust.md", "title": "ADR 0012: Deployment and trust"}]
---

# MCP

The unit exposes a [Model Context Protocol](https://modelcontextprotocol.io)
server so an assistant you run (Claude, a local model, or any MCP client) can
read the same chores, readings, photos and notes as the Care page, and can
run the pump or set the light within the same limits as the app.

Transport is stateless Streamable HTTP at `POST /api/mcp` (GET/DELETE are
accepted on the same path). A request whose `Origin` host does not match
`Host` is rejected (DNS-rebinding guard). The tools are documented in
[ADR-0011](adr/0011-mcp-and-mhs.md); the Care page also prints a `claude mcp add`
command pointed at this unit.

## Access key

By default any client on your LAN can call `/api/mcp`. Settings → MCP access
can set an optional key. When it is set, **only** `/api/mcp` (and any path
under it) requires it, as `X-API-Key` or `Authorization: Bearer`. The web UI,
tRPC, the REST facade, WebSocket, stills and Home Assistant on the LAN do
not need it ([ADR-0012](adr/0012-deployment-and-trust.md)). Loopback
(`127.0.0.1`) is exempt.

```http
POST /api/mcp
X-API-Key: <key>
Content-Type: application/json
Accept: application/json, text/event-stream
```

The result ingest token and the `/api/models` token are separate and
unchanged. To clear the MCP key over SSH:

```sh
/opt/thryve/scripts/thryve-clear-api-key
```

Or:

```sh
curl -X PATCH http://127.0.0.1:3000/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"apiKey":""}'
```

The `Content-Type` header is required.
