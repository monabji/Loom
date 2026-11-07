# Git, exports, and deletion

## Sub-features

Local Git stage/commit/merge/clone, source ZIP export, project deletion confirmation, Trash failure, and cancellation.

## How to get to it (user POV)

Open Git in the workspace. Use project menus in the library to delete a closed synthetic project.

## Driving it with Playwright

Run `npx playwright test tests/e2e/git.spec.ts tests/e2e/project-manager.spec.ts`. Assert commit contents, exported source bytes, preserved siblings, safe cancellation, and retained entries after Trash failure.

## Gotchas

Git tests use local repositories. The project-manager suite injects a Trash failure, then restores the real `shell.trashItem` and verifies successful removal and preserved siblings. This proves host Trash invocation; clean-target Trash recovery and desktop integration remain separate gates.
