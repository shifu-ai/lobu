@AGENTS.md

## Local-only references

- `../owletto` (i.e. `/Users/burakemre/Code/owletto`) is the Owletto source repo. The OpenClaw memory plugin published as `@lobu/owletto-openclaw` lives in `packages/openclaw-plugin` there.

## Owletto

The live Owletto MCP server, ClientSDK, sandbox, and tool registry are in `packages/owletto-backend/` of this repo. The prod `summaries-app-owletto-app` image is built from there (`docker/app/Dockerfile`). Any question about Owletto behavior — MCP tools, instructions, sandbox, SDK, auth — is answered from that path.
