# Prepare a Linux release candidate

Use the [release checklist](README.md) as the only readiness record. Run commands from the repository root, with synthetic projects and an isolated graphical session. Preserve all results under `artifacts/linux-release/`.

## Build and identify the artifact

```sh
npm ci
npm run check
npm run package:appimage
npm run linux:checksum -- release/Loom-0.1.0.AppImage
npm run linux:verify-checksum -- release/Loom-0.1.0.AppImage
```

The packaging script explicitly disables publication. A build exit of zero is not release acceptance. Record the source commit, package version, runtime versions, checksum, OS, architecture, desktop, and actual display backend.

Extract the exact candidate into a new scratch directory. Run `node scripts/linux-release-verify-appdir.mjs <scratch>/squashfs-root` to confirm the shipped launcher and desktop command preserve sandboxing. Keep the original AppImage and checksum unchanged throughout verification.

## Verify the packaged application

Set `LOOM_E2E_EXECUTABLE` to the absolute AppImage path, then run `npm run test:e2e`. With a real TeX toolchain installed, run the same suite with `LOOM_TEST_TEX=1`. Preserve separate missing-tool evidence from the first run. The source suite, extracted executable, mounted AppImage, Xvfb, XWayland, and native Wayland are distinct evidence classes.

For a previous-build profile check, set `LOOM_E2E_UPGRADE_FROM` to the previous packaged executable and `LOOM_E2E_EXECUTABLE` to the candidate. Run the tagged compatibility journeys:

```sh
npx playwright test tests/e2e/project-manager.spec.ts tests/e2e/agent.spec.ts tests/e2e/desktop.spec.ts --grep @upgrade
```

The first launch uses the previous binary; subsequent launches use the candidate and the same temporary profile. Only tests tagged `@upgrade` use the previous binary on their first launch. These journeys compare source bytes, library, settings, appearance, saved conversation text without resubmission, and retained recovery with divergent external source. Ordinary untagged journeys always select the candidate. Future-version metadata refusal is covered by the ProjectService unit test.

Run the exact checksum-identified candidate on fresh Ubuntu 24.04 GNOME Wayland and X11 installations. Test first launch, native folder and file pickers, clipboard, desktop icon and window association, source editing, real PDF compilation, Git, exports, and system Trash recovery. Do not disable Electron sandboxing or globally relax OS security policy to make a test pass. Record missing prerequisites and fail the gate when the documented installation does not launch securely.

Run live supported Codex and OpenCode permission and reconnect checks separately with authorized accounts. Fixture-server results do not establish native provider enforcement. Do not silently enable live opt-ins in shared CI.

## Decide and version

Review dependency audit results, packaged contents, test skips, usability evidence, upgrade compatibility, and all open blockers. Include the source MIT license, the existing brand/font/provider attribution links from the root README, and the packaged `LICENSE.electron.txt` and `LICENSES.chromium.html` in the distribution notes. Preserve the packaged dependency license inventory alongside the evidence. The current version stays `0.1.0` while stable gates remain open. The first stable version is `1.0.0`.

After the gates pass, update the package and lockfile together with `npm version 1.0.0 --no-git-tag-version`. Rebuild, regenerate checksums, and repeat the candidate acceptance checks for the changed artifact. Do not promote the tested `0.1.0` bytes as a `1.0.0` release.

The manual GitHub Actions workflow builds and uploads a candidate artifact; it does not publish a release or certify a real desktop session. It has not been executed during local preparation. Publishing, pushing a tag, uploading a release, or deploying requires explicit user authorization after the final artifact and readiness evidence are available for review.
