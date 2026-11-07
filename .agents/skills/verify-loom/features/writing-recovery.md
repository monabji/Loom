# Writing and recovery

## Sub-features

Edit/save/reopen, external conflicts, IndexedDB recovery, utility interruption, and safe close.

## How to get to it (user POV)

Open a project, edit source, and use the existing recovery and conflict controls after failure injection.

## Driving it with Playwright

Run `npx playwright test tests/e2e/desktop.spec.ts`. The suite checks on-disk source, crash recovery, delayed persistence, restart, keyboard navigation, themes, and small windows.

## Gotchas

SIGSTOP injection is Linux-specific. Use synthetic projects. Test-owned window constraints stabilize tiling compositors.
