# Linux release readiness

Prepare Loom's first stable Linux release with a small scope and auditable evidence.

The canonical specification is [the release spec](../../../.scratch/linux-stable/spec.md). Tickets live in [the local graph](../../../.scratch/linux-stable/issues). This file is the single release checklist and evidence index. Decisions are recorded in `decisions.tsv` beside it.

## Checklist

- [x] Inventory existing workflows, tests, packaging, and recovery boundaries.
- [x] Define candidate Linux targets, scope, acceptance criteria, and dependent tickets.
- [ ] Run baseline and integrated standard checks.
- [ ] Prove the project verification skill using existing Electron tests.
- [ ] Audit complete journeys, keyboard, small windows, failures, and recovery.
- [ ] Wire packaged checks, checksum generation, and local-only release automation.
- [ ] Review dependencies and security boundaries.
- [ ] Verify current and upgraded synthetic data with the packaged candidate.
- [ ] Verify exact AppImage on clean Ubuntu 24.04 GNOME Wayland and X11.
- [ ] Review integrated changes independently and run one retrospective.
- [ ] Decide readiness from evidence; obtain authorization before any publication.

## Evidence index

- Baseline: `artifacts/linux-release/baseline/` (commands, environment, tests, dependency audit).
- Static product audit: `artifacts/linux-release/premium-audit.json`, strict pass with zero findings. This does not prove runtime usability.
- Integrated checks and packaged runs: pending.
- Candidate artifact: pending fresh build; existing ignored release output is not accepted as fresh evidence.
- Clean environments: unverified. Host is Omarchy 4.0.4 x86_64. Docker socket access is denied; no clean Ubuntu run has occurred.

## Current decision

NOT READY. Mandatory packaged, clean-environment, upgrade, and integration evidence is incomplete.

## Estimate

Initial estimate: 2–4 hours of local preparation. Clean-machine and live-provider completion has no reliable ETA until suitable infrastructure is available. Update this estimate at evidence checkpoints.
