# 06: release decision

**What to build:** Review the evidence and decide whether stable publication is justified.

**Priority:** P0

**Blocked by:** 05

**Status:** blocked

- [x] Independent review covers standards and specification, with all high-risk findings resolved.
- [x] Record dependency review, one retrospective, artifact checksum, remaining blockers, and ready/not-ready decision.

## Decision

Local review, the retrospective, and the live Codex/OpenCode permission and reconnect checks are complete on the Omarchy host. The current candidate passes its full mounted behavior and upgrade suites. NOT READY remains recorded in the canonical checklist because ticket 05's clean Ubuntu Wayland/X11 evidence and the remote release workflow are still outstanding. Recheck the build-tool advisories and rebuild as 1.0.0 only after those gates pass.
