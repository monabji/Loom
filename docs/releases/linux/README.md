# Linux release readiness

**Decision: NOT READY for a stable release.** Local preparation is complete on branch `release/linux-readiness`. Live Codex and OpenCode checks now pass on the developer host. Clean supported environments and remote CI evidence are still missing.

The [specification](../../../.scratch/linux-stable/spec.md) defines the scope and acceptance criteria. [Prioritized tickets](../../../.scratch/linux-stable/issues) record dependencies. This file is the single checklist and evidence index; `decisions.tsv` records historical decisions and qualifications.

## Checklist

- [x] Inventory existing workflows, packaging, tests, and recovery boundaries.
- [x] Define a small release scope and candidate Linux targets.
- [x] Establish and prove the existing-harness verification skill and feature map.
- [x] Audit onboarding, core journeys, keyboard access, small windows, errors, and recovery on the host.
- [x] Fix reproduced ZIP Git-metadata import, generated launcher sandbox, and runtime-version issues.
- [x] Add packaged selection, checksum/tamper checks, shipped-notice checks, and artifact-only CI automation.
- [x] Run standard checks, mounted application journeys, real TeX, and saved-data replacement checks.
- [x] Review dependencies, published Electron advisory ranges, and the changed high-risk boundaries.
- [x] Complete independent Standards/Spec review, follow-up review, and one retrospective.
- [ ] Verify the exact candidate on clean Ubuntu 24.04 x86_64 GNOME Wayland and X11, including native desktop integration and Trash recovery.
- [x] Verify live Codex and OpenCode permission prompts, editing, reconnect, and disconnect separately from fixtures on the Omarchy host.
- [ ] Execute the Linux release workflow on GitHub Actions and resolve target-specific installation or sandbox failures.
- [ ] After gates pass, build and reverify the 1.0.0 artifact and obtain authorization before pushing or publishing.

## Final local artifact

`release/Loom-0.1.0.AppImage`, with `release/Loom-0.1.0.AppImage.sha256`.

SHA-256: `050664bfec7130928fb5c8eb01c5a584198a09067dc96cffcfb24822e055cd47`.

Published as the [Loom Linux 0.1.0 Beta prerelease](https://github.com/monabji/loom/releases/tag/v0.1.0-beta.1). Both published assets were downloaded and verified; the AppImage digest matches the candidate above. This beta does not change the stable-release NOT READY decision.

This candidate includes the Codex permission-path disclosure fix. The exact AppImage passed the mounted Electron behavior suite, all three saved-data upgrade journeys, native reconnect checks, and separate supervised live Codex and OpenCode edit/compile/revert journeys. It remains a 0.1.0 candidate, not a stable release.

## Evidence index

- `artifacts/linux-release/baseline/`: original `npm run check` passed with 256 tests and 32 skips; source Electron suite passed with 77 tests and 17 skips. This includes the missing-tool behavior case excluded by the real-TeX run.
- `artifacts/linux-release/post-codex-path-fix-check.log`: full `npm run check` after the permission-path fix.
- `artifacts/linux-release/post-codex-path-fix-appimage-e2e.log`: exact-candidate mounted suite with real TeX; 89 passed, 8 skipped. Candidate SHA-256 is `050664bfec7130928fb5c8eb01c5a584198a09067dc96cffcfb24822e055cd47`.
- `artifacts/linux-release/post-codex-path-fix-upgrades.log`: all 3 tagged old-to-new saved-data journeys passed.
- `artifacts/linux-release/post-codex-path-fix-reconnect.log`: both providers passed reconnect/disconnect checks on the exact candidate.
- `artifacts/linux-release/post-codex-path-fix-live-codex-final.log` and `post-codex-path-fix-live-opencode-final.log`: separate live supervised provider journeys passed; the tests verify requested file paths are visible before approval and source is unchanged until approval.
- `artifacts/linux-release/post-codex-path-fix-checksum.log` and `post-codex-path-fix-appdir-guard.log`: checksum and extracted launcher/desktop/notices checks passed for the candidate.
- `artifacts/linux-release/pre-codex-permission-details/`: retained previous candidate and extraction used as the upgrade source.
- `artifacts/linux-release/final/`: earlier post-review behavior and upgrade evidence, associated with earlier artifact bytes; retained as history.
- `artifacts/linux-release/notices/`: earlier packaging, checksum, launcher/desktop/notices guard, and manifest evidence.
- `artifacts/linux-release/upgrade/`: old and candidate application/executable hashes, selector red/green probe, retained chat text without resubmission, source/preferences/library checks, conflict recovery after binary replacement, and future-version refusal preserving source and logical metadata.
- `artifacts/linux-release/version/`: temporary `0.1.1-release-probe` failed before the version fix and passed afterward. Package metadata was restored byte-for-byte. Focused contract/agent checks, build, formatter, and typecheck passed.
- `artifacts/linux-release/ux-audit.md` and `screenshots/`: observed onboarding, narrow-window, keyboard, PDF guidance, and recovery evidence. Runtime identity and visual tokens are preserved. The feature map lives at `.agents/skills/verify-loom/features/README.md`.
- `artifacts/linux-release/premium-audit.json` and `premium-audit-final.json`: strict static product audits; runtime usability evidence remains separate.
- `artifacts/linux-release/production-audit.json`: zero reported production vulnerabilities. `baseline/npm-audit.json` reports six moderate build-tool package findings and no high/critical findings. `build-audit-high-gate.json` passes the high-severity gate. `electron-advisories.json` retains the official published-advisory query and version-range assessment.
- `artifacts/linux-release/standards-review.md`, `spec-review.md`, `followup-review-result.txt`, and `final-review.md`: independent Sol reviews. Initial upgrade/procedure objections are resolved. The final reviewer left packaging evidence pending; the completed `notices/` evidence closes those local items. Cross-family review was excluded by the model policy.
- `artifacts/linux-release/post-codex-path-fix-*`: final exact-candidate checks after the Codex path-disclosure fix. Earlier `resume-*` logs belong to the superseded candidate and are retained as historical evidence.
- `artifacts/linux-release/resume-host-access.md`: current remote workflow, branch, container, and VM access checks. GitHub CLI access is available, but the remote repository has no Linux release workflow and this branch is not on origin.
- Earlier `integrated/`, native failure logs, and extracted-image proofs remain historical evidence. Initial native mounting failed for missing FUSE components; the successful host run used the recorded local setup.

## Verified environment and limits

Verified locally: Omarchy 4.0.4 x86_64, kernel 7.2.3-arch1-3, Node 26.7.0, npm 11.19.0, Electron 45.2.1, and the installed local TeX/TexLab toolchain. The desktop session reports Wayland with both DISPLAY and WAYLAND_DISPLAY. Electron's native Wayland versus XWayland backend was not independently established.

Mounted checks required a checksum-verified Ubuntu FUSE2 library in the evidence directory and a local link to the host's fusermount3. No system packages or global security policy changed. A clean profile on this host is not a clean Ubuntu machine. Codex and OpenCode live permission and reconnect journeys now pass on this host, but they do not establish those behaviors on clean Ubuntu targets. Host Trash invocation is exercised, including injected failure and subsequent real removal; supported-target Trash recovery remains unverified.

GitHub CLI is authenticated. Branch `release/linux-readiness` is pushed, but GitHub exposes only the regular CI workflow from the default branch. The Linux release workflow is on the release branch and is not dispatchable until it is available from the default branch. No remote Linux workflow result exists. Docker access is denied and no QEMU binary is installed on the host.

See [integration skips](skips.md), [security review and candidate exceptions](security-review.md), [installation and backups](install.md), [release procedure](release.md), and [retrospective](retro.md).

## Changes completed

ZIP imports exclude Git metadata while preserving ordinary source and assets. The packaged launcher retains sandboxing and arguments. Runtime status and agent-handshake versions derive from package metadata. Existing Electron tests now select a common executable and compare saved conversations and recovery across binary replacement. Candidate automation checks dependencies, checksums, the actual launcher, and bundled notices without publishing a release.

The existing visual identity is unchanged. Performance work was not selected because no reproduced performance regression justified an optimization.

## Remaining time

The live provider checks are complete on the host. The remaining work is clean Ubuntu Wayland/X11 validation, the remote release workflow, refreshed dependency review, and a rebuilt 1.0.0 artifact after those gates pass. Estimate 1–3 working days once those environments and remote execution are available, if checks pass without fixes. The version remains 0.1.0 until then.
