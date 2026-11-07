# Linux release readiness

Prepare Loom's first stable Linux release with a small scope and auditable evidence.

The canonical specification is [the release spec](../../../.scratch/linux-stable/spec.md). Tickets live in [the local graph](../../../.scratch/linux-stable/issues). This file is the single release checklist and evidence index. Decisions are recorded in `decisions.tsv` beside it.

## Checklist

- [x] Inventory existing workflows, tests, packaging, and recovery boundaries.
- [x] Define candidate Linux targets, scope, acceptance criteria, and dependent tickets.
- [ ] Run baseline and integrated standard checks. Baseline passes; integrated run pending.
- [x] Prove the project verification skill using existing Electron tests. Extracted candidate project startup passed.
- [x] Audit complete journeys, keyboard, small windows, failures, and recovery on the developer host. See `artifacts/linux-release/ux-audit.md`; clean desktop integration remains open.
- [x] Wire packaged checks, checksum generation, and artifact-only release automation. The remote workflow has not been executed.
- [ ] Review dependencies and security boundaries.
- [ ] Verify current and upgraded synthetic data with the packaged candidate.
- [ ] Verify exact AppImage on clean Ubuntu 24.04 GNOME Wayland and X11.
- [ ] Review integrated changes independently and run one retrospective.
- [ ] Decide readiness from evidence; obtain authorization before any publication.

## Evidence index

- Baseline: `artifacts/linux-release/baseline/`: `npm run check` exit 0, 256 tests passed and 32 skipped; Electron exit 0, 77 passed and 17 skipped. Active developer display, not Xvfb.
- Static product audit: `artifacts/linux-release/premium-audit.json`, strict pass with zero findings. This does not prove runtime usability.
- Extracted pre-fix AppImage: `project-manager-proof.log` passes one startup/create/save/reopen journey; `latex-proof.log` passes 10 real TeX journeys with two explicit skips. These results predate the launcher fix.
- Native pre-fix AppImage launch: `native-appimage-proof.log` fails with missing `libfuse.so.2`; failure trace retained in `native-failure/`.
- Production audit: `artifacts/linux-release/production-audit.json`, zero reported vulnerabilities. Full audit reports six moderate build-tool findings.
- Launcher regression: `launcher-red.log`, `launcher-green.log`, and `launcher-typecheck.log`. Generated upstream launcher disabled sandboxing; custom launcher preserves flags and failure status. Final packaged proof pending.
- Candidate artifact: `release/Loom-0.1.0.AppImage`, local pre-stable diagnostic build. Rebuild and checksum refresh required after integration.
- Clean environments: unverified. Host is Omarchy 4.0.4 x86_64. Docker socket access is denied; no clean Ubuntu run has occurred.

## Implementation completed

- ZIP paper imports now exclude every `.git` component, matching folder import behavior. Nine inert archive regressions preserve ordinary source and assets.
- AppImage packaging uses a reviewed launcher that preserves Electron sandboxing. The actual extracted launcher and desktop entry are checked before CI runtime tests.
- All Electron suites select the same packaged executable. An optional previous-build selector permits a synthetic-profile upgrade check through the existing startup journey.
- SHA-256 generation and tamper verification are automated. The manual CI workflow builds and retains candidates without publishing a release.
- Installation, backup, replacement, known gaps, and verification guidance are documented.

## Current decision

NOT READY. Mandatory packaged, clean-environment, upgrade, and integration evidence is incomplete.

## Estimate

Initial estimate: 2–4 hours of local preparation. Clean-machine and live-provider completion has no reliable ETA until suitable infrastructure is available. Update this estimate at evidence checkpoints.
