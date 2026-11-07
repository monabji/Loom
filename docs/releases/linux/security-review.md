# Linux release security review

## Dependency evidence

The baseline `npm audit --json` reports six moderate findings, zero high, and zero critical findings. They are development/build-tool dependencies through electron-builder and minimatch. The production dependency audit must also be retained. Audit output is a point-in-time registry result, not a complete security guarantee.

[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) describes glob-pattern amplification in minimatch versions before 11.0.1. The baseline lockfile includes affected versions under the packaging tools. The package configuration uses repository-controlled globs. Do not package untrusted source changes or accept attacker-controlled build patterns. This mitigation does not resolve the advisory; review upstream-compatible remediation before publication. The audit's proposed electron-builder downgrade is not applied without compatibility evidence.

Electron 45.2.1 is pinned. Its [official release notes](https://releases.electronjs.org/release/v45.2.1) record Chromium fixes. No claim of complete Electron advisory clearance is made from an npm audit alone.

## Application boundaries

The inventory found sandboxed, isolated renderers with Node integration disabled; blocked navigation and popups; denied browser permissions; validated IPC; and SQLite WAL with full synchronization. Existing tests exercise these boundaries. The independent release review must inspect the changed test-launch paths to ensure packaged runs retain them.

Review source-import path traversal and size limits, export destinations, symlinks, agent command ownership, permission forwarding, recovery preservation, and log redaction before signing off. Native harness permission enforcement requires live integration evidence. Fixture servers establish only the adapter and UI contract.

## Outstanding evidence

- Production audit and packaged dependency inventory.
- Independent security-boundary review.
- Live native provider permission/reconnect checks.
- Clean target sandbox and native launch evidence.
- A signing and distribution decision before stable publication.
