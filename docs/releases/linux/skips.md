# Integration evidence and opt-ins

The standard check reports 10 wholly skipped files and 32 skipped tests, including opt-ins in otherwise executed files. The full mounted run with real TeX reports eight skipped Electron tests. Skips are not passes. The canonical totals and exact test names remain in the logs linked from the [release checklist](README.md).

## Unit-run integration prerequisites

- `tests/latex-live.test.ts` requires `LOOM_TEST_TEX=1` and installed TeX tools. Real PDF compilation is separately exercised by the mounted Electron suite.
- `tests/agent-live.test.ts` uses `LOOM_AGENT_LIVE=1` for native connection checks, `LOOM_AGENT_INFERENCE=1` for OpenCode inference, and `LOOM_CODEX_INFERENCE=1` for Codex inference. Harness installations and authorized accounts are required.
- `tests/agent-workflow-live.test.ts` selects `codex`, `classic`, or `next` through comma-separated `LOOM_WORKFLOW_LIVE`. Classic also needs its explicit executable path.
- `tests/agent-image-live.test.ts` and `tests/agent-computation-live.test.ts` select `opencode`, `codex`, or both through `LOOM_IMAGE_LIVE` and `LOOM_COMPUTE_LIVE`. Appropriate model capabilities and authorized accounts are required.
- The image, diagram, and science workflow files require `LOOM_IMAGE_WORKFLOW=1`, `LOOM_DIAGRAM_WORKFLOW=1`, and `LOOM_SCIENCE_WORKFLOW=1`, respectively, plus their documented native provider/tool prerequisites.
- `tests/phase8-compile-gate.test.ts` also requires `LOOM_TEST_TEX=1` and the installed toolchain.
- Real TeX cases in `tests/agent-conversations-review.test.ts` and `tests/agent-tools-tikz.test.ts` require `LOOM_LATEX_LIVE=1`; the latter also has an inference case controlled by `LOOM_AGENT_INFERENCE=1`.
- Four actual classic-provider probes in `tests/opencode-classic.test.ts` require an explicit `LOOM_CLASSIC_PROBE` executable and the prerequisites described in that file.
- `tests/research-live.test.ts` requires `LOOM_RESEARCH_AGENT_LIVE=1`, network access, and its native provider prerequisites.

Inspect each test's setup before enabling it. These opt-ins can invoke real providers and tools. None was silently enabled for the standard check.

## Eight default Electron skips with real TeX enabled

- One missing-tool case is intentionally excluded by `LOOM_TEST_TEX=1`. It passed in the default source baseline where TeX opt-in was absent.
- One authorized-paper case additionally requires `LOOM_PDF_PAPER` to identify an explicit synthetic paper.
- One live agent creation/compile/revert journey requires `LOOM_AGENT_DESKTOP_LIVE=1` and its chosen native harness. Separate exact-candidate runs passed for Codex and OpenCode on the Omarchy host after the Codex permission-path fix.
- Two native reconnect journeys require `LOOM_NATIVE_RECONNECT=1` and installed harnesses. Both passed against the exact candidate on the Omarchy host.
- Two large synthetic workload journeys require `LOOM_PHASE8_PROJECT` and their packaged/TeX prerequisites. No performance claim or optimization is based on these skipped workloads.
- One live arXiv journey requires `LOOM_RESEARCH_LIVE=1`, network access, and real TeX. Local reference and Zotero fixture imports run separately.

## Environment limits

The mounted application ran on the Omarchy developer host with locally supplied FUSE components. A Wayland desktop with X11 variables does not establish whether Electron used native Wayland or XWayland. Live Codex and OpenCode supervised permission, edit, PDF, revert, reconnect, and disconnect checks passed on this host. The Codex check verifies affected paths are shown before approval and that source remains unchanged before the user approves. Clean Ubuntu GNOME Wayland and X11 and native desktop integration on those targets remain unverified. Earlier OpenCode runs had one timeout and two selector failures while the test was being hardened; the final exact-candidate run passed.
