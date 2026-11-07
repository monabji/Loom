# Git, exports, and deletion

## Sub-features

Local Git stage/commit/merge/clone, source ZIP export, project deletion confirmation, Trash failure, and cancellation.

## How to get to it (user POV)

Open Git in the workspace. Use project menus in the library to delete a closed synthetic project.

## Driving it with Playwright

Run `npx playwright test tests/e2e/git.spec.ts tests/e2e/project-manager.spec.ts`. Assert commit contents, exported source bytes, preserved siblings, safe cancellation, and retained entries after Trash failure.

## Gotchas

Git tests use local repositories. Native Trash is intercepted in fixtures, so real system Trash and desktop integration remain manual clean-target gates.
