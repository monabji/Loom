# Harness compatibility

Loom must connect to compatible native OpenCode and Codex releases without a minor-version allowlist. Detect OpenCode's modern or classic HTTP protocol from read-only probes; preserve loopback/authentication restrictions and do not fall back after authentication, transport, or server errors. Codex uses the app-server handshake and default stdio transport. Unknown versions are attempted, not assumed incompatible. Releases without the required native protocol receive an actionable error; no guarantee is made for arbitrary future breaking protocols.

Acceptance: real installed OpenCode 2.3.0 and Codex 0.169.0 connect, list models, create/resume sessions and perform synthetic edits. Older protocol fixtures and available older binaries retain approvals, questions, interruption, MCP and history. Document tested versions and avoid claiming exhaustive version coverage. Update the installed AppImage after checks.
