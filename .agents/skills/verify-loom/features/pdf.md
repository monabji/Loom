# PDF compilation and export

## Sub-features

Missing tools, real compilation, last successful PDF, cancellation, SyncTeX, and export.

## How to get to it (user POV)

Use Try a sample paper and build from the workspace. BuildFeedback owns recovery actions.

## Driving it with Playwright

Run `npx playwright test tests/e2e/latex.spec.ts` for missing-tool behavior; run again with `LOOM_TEST_TEX=1` for actual TeX. Verify PDF content and export bytes, not merely an output filename.

## Gotchas

Real TeX and TexLab are separate installed prerequisites. The authorized-paper test remains skipped without an explicit synthetic input path.
