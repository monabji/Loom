# Linux release security review

## Dependency evidence

The baseline `npm audit --json` reports six moderate findings, zero high, and zero critical findings. They are development/build-tool dependencies through electron-builder and minimatch. The retained production-only audit reports zero vulnerabilities. Audit output is a point-in-time registry result, not a complete security guarantee.

[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) describes glob-pattern amplification in minimatch versions before 11.0.1. The baseline lockfile includes affected versions under the packaging tools. The package configuration uses repository-controlled globs. Do not package untrusted source changes or accept attacker-controlled build patterns. This mitigation does not resolve the advisory; review upstream-compatible remediation before publication. The audit's proposed electron-builder downgrade is not applied without compatibility evidence.

Electron 45.2.1 is pinned. Its [official release notes](https://releases.electronjs.org/release/v45.2.1) record Chromium fixes. The official repository advisory API was also checked on 2026-11-07: 70 published advisories, 209 Electron version-range records, and no additional pagination. No matching high or critical range was found for 45.2.1. The only matching range was [GHSA-vv43-5jgx-7qv8](https://github.com/electron/electron/security/advisories/GHSA-vv43-5jgx-7qv8), whose description limits exposure to macOS Squirrel.Mac updates. Loom's Linux candidate does not ship that update path. The retained query is `artifacts/linux-release/electron-advisories.json`. This checks published Electron advisories, not every possible Chromium or Node vulnerability.

## Application boundaries

The inventory found sandboxed, isolated renderers with Node integration disabled; blocked navigation and popups; denied browser permissions; validated IPC; and SQLite WAL with full synchronization. Existing tests exercise these boundaries. The independent release review must inspect the changed test-launch paths to ensure packaged runs retain them.

Review source-import path traversal and size limits, export destinations, symlinks, agent command ownership, permission forwarding, recovery preservation, and log redaction before signing off. Native harness permission enforcement requires live integration evidence. Fixture servers establish only the adapter and UI contract.

## Outstanding evidence

- Final packaged dependency inventory. Production audit is retained and passed.
- Independent review completed for the changed ZIP and launcher boundaries; review follow-up remains open for upgrade coverage.
- Live native provider permission/reconnect checks.
- Clean target sandbox and native launch evidence.
- Recheck advisories before stable publication. The candidate uses SHA-256 and a trusted distribution channel; no Linux signing identity or automatic updater is included.

## Defensive changes

ZIP paper imports now exclude `.git` path components, matching folder imports. Nine inert cases exercise root, wrapper, nested, directory, and file entries while preserving ordinary bytes. The generated AppImage desktop entry and AppRun previously disabled sandboxing; packaging now supplies a minimal reviewed launcher, and CI checks the actual extracted files. The Electron boundary test also checks that the no-sandbox switch is absent. Independent Standards and Spec reviewers inspected the changed boundaries and ran inert checks without finding an additional production defect. Their reports are in `artifacts/linux-release/standards-review.md` and `spec-review.md`.

## Candidate build-tool exception

The coordinator retains the six moderate npm build-tool findings for local candidate preparation. All affected npm packages are development dependencies; no production finding was reported. Packaging globs come from trusted repository configuration, and untrusted build changes are excluded. This exception avoids an unverified major packaging downgrade. It expires at the stable publication decision, where the audit must be refreshed and remediation or an explicit continuing exception recorded.
