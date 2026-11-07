# Linux release readiness

**Decision: NOT READY for a stable release.** Local preparation is complete on branch `release/linux-readiness`. Clean supported environments and live integration evidence are still missing.

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
- [ ] Verify live supported Codex/OpenCode permission and reconnect enforcement separately from fixtures.
- [ ] Execute the remote release workflow and resolve target-specific installation or sandbox failures.
- [ ] After gates pass, build and reverify the 1.0.0 artifact and obtain authorization before pushing or publishing.

## Final local artifact

`release/Loom-0.1.0.AppImage`, with `release/Loom-0.1.0.AppImage.sha256`.

SHA-256: `644edd4be3ceb4fe3c7f35c92f5419b24f5bef6cbd9c4c149e78063ee3e5038e`.

The final rebuild adds distribution notices. Its `app.asar` is byte-identical to the fully tested build. Two native smoke journeys passed against this exact final AppImage. The complete 89-test behavior pass is associated with the earlier checksum below, rather than falsely attributed to the final notice-only checksum.

## Evidence index

- `artifacts/linux-release/baseline/`: original `npm run check` passed with 256 tests and 32 skips; source Electron suite passed with 77 tests and 17 skips. This includes the missing-tool behavior case excluded by the real-TeX run.
- `artifacts/linux-release/final/`: post-review standard check passed with 266 unit tests and 32 skips; checksum tamper test passed; mounted AppImage with real TeX passed 89 Electron tests with 8 skips; all 3 tagged upgrade journeys passed. Full-behavior AppImage SHA-256 is `28cdd8f4db81b342619dcb02539539b31bf37805e84779dd62224ccb975e6077`. That image and its extraction are retained.
- `artifacts/linux-release/notices/`: final packaging, checksum verification, extracted launcher/desktop/notices guard, byte-identical application-archive proof, 2 native smoke tests, and `manifest.json` identifying the exact artifact and evidence classes.
- `artifacts/linux-release/upgrade/`: old and candidate application/executable hashes, selector red/green probe, retained chat text without resubmission, source/preferences/library checks, conflict recovery after binary replacement, and future-version refusal preserving source and logical metadata.
- `artifacts/linux-release/version/`: temporary `0.1.1-release-probe` failed before the version fix and passed afterward. Package metadata was restored byte-for-byte. Focused contract/agent checks, build, formatter, and typecheck passed.
- `artifacts/linux-release/ux-audit.md` and `screenshots/`: observed onboarding, narrow-window, keyboard, PDF guidance, and recovery evidence. Runtime identity and visual tokens are preserved. The feature map lives at `.agents/skills/verify-loom/features/README.md`.
- `artifacts/linux-release/premium-audit.json` and `premium-audit-final.json`: strict static product audits; runtime usability evidence remains separate.
- `artifacts/linux-release/production-audit.json`: zero reported production vulnerabilities. `baseline/npm-audit.json` reports six moderate build-tool package findings and no high/critical findings. `build-audit-high-gate.json` passes the high-severity gate. `electron-advisories.json` retains the official published-advisory query and version-range assessment.
- `artifacts/linux-release/standards-review.md`, `spec-review.md`, `followup-review-result.txt`, and `final-review.md`: independent Sol reviews. Initial upgrade/procedure objections are resolved. The final reviewer left packaging evidence pending; the completed `notices/` evidence closes those local items. Cross-family review was excluded by the model policy.
- Earlier `integrated/`, native failure logs, and extracted-image proofs remain historical evidence. Initial native mounting failed for missing FUSE components; the successful host run used the recorded local setup.

## Verified environment and limits

Verified locally: Omarchy 4.0.4 x86_64, kernel 7.2.3-arch1-3, Node 26.7.0, npm 11.19.0, Electron 45.2.1, and the installed local TeX/TexLab toolchain. The desktop session reports Wayland with both DISPLAY and WAYLAND_DISPLAY. Electron's native Wayland versus XWayland backend was not independently established.

Mounted checks required a checksum-verified Ubuntu FUSE2 library in the evidence directory and a local link to the host's fusermount3. No system packages or global security policy changed. A clean profile on this host is not a clean Ubuntu machine. Git, agent, and Zotero fixtures do not establish live remote/provider enforcement. Host Trash invocation is exercised, including injected failure and subsequent real removal; supported-target Trash recovery remains unverified.

See [integration skips](skips.md), [security review and candidate exceptions](security-review.md), [installation and backups](install.md), [release procedure](release.md), and [retrospective](retro.md).

## Changes completed

ZIP imports exclude Git metadata while preserving ordinary source and assets. The packaged launcher retains sandboxing and arguments. Runtime status and agent-handshake versions derive from package metadata. Existing Electron tests now select a common executable and compare saved conversations and recovery across binary replacement. Candidate automation checks dependencies, checksums, the actual launcher, and bundled notices without publishing a release.

The existing visual identity is unchanged. Performance work was not selected because no reproduced performance regression justified an optimization.

## Remaining time

Local preparation is finished. Stable validation has no reliable completion estimate until clean Ubuntu Wayland/X11 environments and authorized live-provider test access are available. The version remains 0.1.0 until the stable gates pass; the 1.0.0 artifact must then be rebuilt and reverified.
