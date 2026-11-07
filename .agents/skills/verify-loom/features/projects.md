# Projects and imports

## Sub-features

Create, open, import ZIP, switch projects, and resume from the library.

## How to get to it (user POV)

Start at Your projects. Create project, Open folder, and workspace settings expose the established entry points.

## Driving it with Playwright

Run `npx playwright test tests/e2e/project-manager.spec.ts tests/e2e/desktop.spec.ts --grep "startup library|native project creation|cancelled pickers"`. Assert ordinary source and assets, independent project preferences, and restart state.

## Gotchas

Native pickers are intercepted in tests. Real desktop picker behavior needs clean-target manual evidence.
