# 05: candidate validation

**What to build:** Validate the exact candidate and its saved-data compatibility on clean targets.

**Priority:** P0

**Blocked by:** 02, 03, 04

**Status:** blocked

- [x] Run real TeX and synthetic profile upgrade checks; distinguish live agents from fixture checks.
- [x] Verify live Codex and OpenCode supervised permissions, editing, reconnect, and disconnect on the exact candidate host build.
- [x] Require Codex approval UI to show affected paths before approval and verify no file changes before approval.
- [ ] Ubuntu 24.04 Wayland and X11 pass exact AppImage journeys, native launch, and desktop integration.

## Blocker

Clean Ubuntu 24.04 GNOME Wayland and X11 environments are unavailable. The exact candidate (`050664bfec7130928fb5c8eb01c5a584198a09067dc96cffcfb24822e055cd47`) passed the mounted behavior suite (89 passed, 8 skipped), all three saved-data upgrade journeys, and separate live Codex/OpenCode checks on the Omarchy host. Native desktop integration and Trash recovery on supported Ubuntu targets remain unverified.
