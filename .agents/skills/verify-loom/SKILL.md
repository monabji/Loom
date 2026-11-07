---
name: verify-loom
description: Verify Loom desktop release journeys with the existing Electron Playwright suite, including packaged builds, recovery, and Linux release evidence.
---

# Verify Loom

Read `docs/releases/linux/README.md` for the release gates and evidence index. The Electron suite is the runtime driver. Do not create a second browser harness.

## Launch

From the repository root, run `npm ci` when dependencies are absent, then `npm run build`. In a graphical Linux session, run `npx playwright test tests/e2e/project-manager.spec.ts --grep "startup library creates"`. Each test launches Electron with a temporary `--user-data-dir`, waits for the library or service ready state, and closes the owned application in teardown. Never point tests at a personal profile or manuscript.

For packaged verification, build with `npm run package:appimage -- --publish never`. This appends the no-publication flag to the existing builder invocation. Set `LOOM_E2E_EXECUTABLE` to an absolute executable path before invoking Playwright. All required suites must honor that selector. The shared `electronLaunchOptions` helper selects the supplied executable for every suite. Legacy `LOOM_AGENT_PACKAGED=1` remains supported. Do not label a run packaged unless the selected executable and checksum are recorded.

## Doctor

Run `node --version`, `npm --version`, `npx playwright test --list`, and inspect the selected executable with `file`. Confirm a graphical session exists, the binary belongs to this build, and the evidence directory is outside temporary profiles. Clear inherited `ELECTRON_RUN_AS_NODE` and renderer dev URLs through the existing launch code. Keep Chromium sandboxing enabled. A missing tool or failed launch is a failed prerequisite, not a reason to bypass security.

## Drive

Use `features/README.md` to select the suites. For the initial proof, the project-manager startup test uses the accessible heading `Your projects` and the project library workflow, then creates and reopens projects with isolated writing and preferences. Use existing assertions and native-dialog fixtures. Do not replace the observable journey with direct state setters.

Run `npm run test:e2e` for the fixture baseline. Run real TeX separately with `LOOM_TEST_TEX=1 npx playwright test tests/e2e/latex.spec.ts`; the toolchain must already be installed and discoverable. Live providers require separate explicit opt-ins and authorized accounts. Never equate fixture servers with live provider evidence.

## Evidence

Save commands, exit codes, environment, counts including skips, and complete logs under `artifacts/linux-release/`. The runner retains failure traces in `test-results/`; copy relevant traces into the release evidence directory before another run replaces them. Preserve screenshots under their suite-defined artifact paths. Check resulting source, exported bytes, retained recovery, and reopened UI state. A source run, an unpacked executable run, an extracted AppImage run, and a native mounted AppImage run are distinct evidence classes.

For clean-target proof, record OS version, architecture, session type, tool versions, AppImage SHA-256, fresh profile, optional integrations enabled, and every manual setup step. Xvfb and a fresh profile on a developer workstation do not prove clean Ubuntu Wayland support.

## Cleanup

Allow test teardown to close only the Electron processes and temporary projects it created. On failure, use the recorded owned PID if manual cleanup is necessary. Never kill by process name or remove a user's profile. Keep logs, traces, screenshots, and checksums after cleanup. Confirm the proof log remains readable.

## Helpers

The existing Playwright runner and `tests/e2e/helpers/project-library.ts` own launch journeys and project resumption. No extra driver is needed. Use `npm run linux:checksum -- release/Loom-0.1.0.AppImage` and `npm run linux:verify-checksum -- release/Loom-0.1.0.AppImage`. After extraction, run `node scripts/linux-release-verify-appdir.mjs <extracted-root>` to check the shipped launcher. Maintain this feature map with `pstack:maintain-verification-skill` when product flows change.
