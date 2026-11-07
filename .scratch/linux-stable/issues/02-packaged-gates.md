# 02: packaged gates

**What to build:** Run existing core journeys against the built Linux executable and produce checksum-identified artifacts.

**Priority:** P0

**Blocked by:** 01

**Status:** resolved

- [x] Desktop, Git, agent, project, PDF, and research specs honor the same packaged executable selector.
- [x] CI automation checks and builds an AppImage without publishing; checksum verification fails for changed bytes.

## Evidence

See docs/releases/linux/README.md for the canonical commands and evidence index. Implementation is local; clean-target and live-integration acceptance remains owned by ticket 05.
