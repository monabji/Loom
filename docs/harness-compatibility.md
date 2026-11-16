# Harness compatibility

Loom connects to the native APIs exposed by the installed harness. A version number outside a fixed minor range no longer prevents a connection. Install and authenticate OpenCode or Codex separately; Loom does not bundle either harness.

## How compatibility is checked

OpenCode is probed through its read-only server endpoints. Loom selects the current `/api/*` adapter when `/api/info` responds with a version, or the classic adapter when that endpoint is absent and `/global/health` identifies a healthy classic server. Authentication, server and transport errors do not cause fallback to another API. Owned servers must enforce authentication on their loopback endpoint.

Codex uses `codex app-server` with its default stdio transport and the native `initialize` handshake. Loom uses the thread and turn APIs, model catalog, approval requests and MCP configuration. Older catalogs without `inputModalities` retain the documented text/image default. Unknown optional response fields are ignored. Unsupported native approval requests remain denied rather than being automatically accepted.

Loom's MCP tools accept the standard `_meta` request field independently of their tool arguments. Project paths, file operations, recovery checkpoints and authentication retain their existing validation.

## Verified versions

Connection, model listing and project-bound sessions were exercised against these real binaries on Linux:

- OpenCode 1.18.29, 1.19.0 and 2.3.0.
- Codex 0.104.0, 0.159.2, 0.159.3 and 0.169.0.

Real edit and revert checks also passed for OpenCode 1.18.29 and 2.3.0 and Codex 0.159.3 and 0.169.0. Codex 0.104.0 passed connection/session checks, but its default catalog selected the retired `gpt-5.2-codex` model, which the current ChatGPT account rejected. This is an upstream model availability limitation, not a version refusal by Loom. Native turn failures now retain the reported reason in Loom. The final AppImage also passed separate live desktop journeys for OpenCode 2.3.0 and Codex 0.169.0: supervised permission approval, LaTeX file creation, PDF compilation and safe revert.

The current registry releases at verification were OpenCode 2.3.0 and Codex 0.169.0. Fixture tests also cover future version labels using the same supported protocols, API selection independent of version labels, authentication failures, tool metadata, approvals, questions and interruption. A fixture is not evidence that an unreleased version works.

A release that removes or changes the required APIs can still be incompatible. Ancient releases without the native server protocol cannot be supported by removing a version check. Connection or request errors identify the failed operation; selecting another installed executable remains available in Agent connections → Runtime. Provider sign-in, model availability and rate limits are separate from harness compatibility.

## Reproduce

Run `npm run check` for the contract and regression suite. Live connection checks do not perform inference:

```sh
LOOM_AGENT_LIVE=1 npx vitest run tests/agent-live.test.ts -t 'catalogs and project-bound'
```

Use `LOOM_OPENCODE_EXECUTABLE` and `LOOM_CODEX_EXECUTABLE` to select alternate binaries for these checks. Inference checks require the corresponding explicit `LOOM_AGENT_INFERENCE=1` or `LOOM_CODEX_INFERENCE=1` opt-in and a configured model. `LOOM_OPENCODE_MODEL` selects an OpenCode test model; the default test model can be unavailable or rate-limited independently of the adapter.

## Upstream references

- [OpenCode classic server API](https://opencode.ai/v1/docs/server/).
- [Codex app-server handshake, default stdio transport and model catalog](https://developers.openai.com/codex/app-server).
- [MCP metadata](https://modelcontextprotocol.io/specification/2025-06-18/basic#_meta).
