# Agents and permissions

## Sub-features

Connect, permission choices, cancellation, interrupted streams, reconnect, draft and attachment retention.

## How to get to it (user POV)

Open Agent connections from the workspace and use the composer. Harness permissions remain owned by the native provider.

## Driving it with Playwright

Run `npx playwright test tests/e2e/agent.spec.ts`. Record fixture server coverage separately. Live tests are opt-in through `LOOM_AGENT_DESKTOP_LIVE=1`; `tests/e2e/provider-reconnect.spec.ts` requires `LOOM_NATIVE_RECONNECT=1`.

## Gotchas

Live tests can send provider requests and incur cost. Do not enable or use credentials without appropriate authorization. Fixture permission behavior does not prove native harness enforcement.
