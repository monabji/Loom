# Linux release retrospective

This is the single retrospective for this preparation run. Sources are the committed diff, decision trail, baseline and packaged logs, version probe, upgrade evidence, and three independent review rounds. No unrelated session history was read.

## Prevention encoded

- Source-only tests missed the builder's generated sandbox-disabling launcher. The release workflow now inspects the actual extracted AppRun and desktop command, and Electron asserts that sandbox disabling is absent.
- Folder and ZIP imports disagreed about Git metadata. Nine inert behavioral cases compare the two import paths while preserving source and assets.
- Individual suites selected packaged binaries differently. One launch helper now owns selection, with small source/package/legacy-option checks.
- The first upgrade selector leaked into ordinary tests. Tagged upgrade journeys now select the old binary only for initial setup; an invalid-old-path probe demonstrates that an untagged test still uses the candidate.
- Package version and runtime identifiers could diverge. Runtime metadata now imports the package version, and an isolated temporary-version probe failed before the fix and passed afterward. The permanent Electron assertion compares public status with package metadata.
- Artifact inventory found Loom and asset notices absent after expensive behavior checks had started. The package now includes them and the shipped-content guard checks exact bytes. Run artifact-content inspection before long runtime checks in future release runs.

## Process result

The existing formatter, typecheck, unit tests, Electron harness, and CI were reused. No second verification driver, new updater, visual redesign, or speculative performance change was introduced. Findings were reproduced with focused loops before fixes; larger checks ran at integration boundaries. Cross-family review was excluded by the requested model policy; independent Sol reviewers performed the release reviews.

The remaining work depends on clean supported desktop environments and authorized live integration validation. Developer-host fixtures and local FUSE setup cannot resolve those gates. The release checklist records NOT READY and keeps the version pre-stable.
