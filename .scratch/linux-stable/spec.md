# First stable Linux release specification

Status: ready-for-agent. Owner: release coordinator. Scope is deliberately limited to existing workflows.

## Problem statement

Researchers need a Linux desktop build that preserves writing across failures, explains missing tools, and can be installed and upgraded with verified artifacts.

## Solution

Prepare a local release candidate and release gates. Stable publication requires all mandatory evidence. Keep the existing visual identity, native permission ownership, ordinary source folders, and local recovery.

## User stories

1. As a researcher, I can launch an AppImage with an empty profile and find create, open, import, and sample actions.
2. As a researcher, I can edit and save ordinary source, reopen the application, and recover after renderer or service interruption.
3. As a researcher, I can inspect conflicting external edits without silently losing either version.
4. As a researcher, I can compile and export a real PDF, or see actionable missing-tool and build errors while retaining source and the last successful PDF.
5. As a researcher, I can connect an optional supported agent, approve or deny native permissions, cancel, and reconnect without replaying a request.
6. As a researcher, I can inspect Git changes, stage, commit, merge explicitly, and export a portable source archive.
7. As a researcher, I can cancel deletion or send a closed project to system Trash while preserving sibling projects and recovery on failure.
8. As a keyboard user, I can reach primary actions, dismiss dialogs, restore focus, and use a 720 by 540 workspace.
9. As a Linux user, I can verify a checksum, launch from a path containing spaces, and understand desktop integration and optional dependencies.
10. As an existing user, I can back up source and application data and verify upgrade compatibility before replacing a working binary.

## Implementation decisions

- Initial stable validation target: Ubuntu 24.04 LTS x86_64, GNOME Wayland and X11. These remain candidate targets until packaged checks pass. Omarchy is additional evidence, not a substitute.
- Deliver one AppImage and SHA-256 checksum. Manual replacement upgrades; no auto-updater or distribution-specific package is added.
- Keep the current pre-stable version until gates pass. First stable version is 1.0.0; generate and reverify a versioned candidate before authorizing publication.
- Keep the renderer sandbox, validated IPC, path restrictions, provider-owned permission prompts, and recovery storage intact.
- Use the existing Electron Playwright suite for source and packaged checks. Do not add a separate browser driver.
- Release automation builds and uploads CI artifacts only, without publishing a GitHub Release.

## Testing decisions and acceptance criteria

- Standard formatting, typecheck, unit tests, and production build pass. Every skipped integration is listed with its required prerequisite.
- Existing Electron journeys pass with isolated profiles for first launch, create/import, edit/save/reopen, crash/conflict recovery, PDF success/failure, agent fixture permissions/reconnect, Git, exports, and deletion.
- Real TeX checks pass with an installed toolchain. Fixture agents prove UI contracts only; live Codex and OpenCode connect/permission/reconnect results must be recorded separately before claiming those integrations verified.
- The exact checksum-identified AppImage passes the journey suite on clean Ubuntu 24.04 Wayland and X11, preserving Electron sandboxing. Native mount launch and desktop launcher/icon/open-folder behavior are checked separately from extracted execution.
- Upgrade a synthetic profile from the previous 0.1.0 build to the candidate. Compare source bytes, preferences, project library, chats, and recovery after restart. Future-version metadata refusal preserves files. No downgrade compatibility is promised.
- Dependency review has no unresolved high/critical production advisories. Review build dependencies and Electron advisories too. Exceptions require explicit recorded justification.
- No unresolved data-loss, crash, security-boundary, inaccessible core-action, or broken core-workflow defect remains.
- Installation, backup/upgrade, known issues, supported matrix, third-party notices, checksum verification, and release steps are documented.

## Out of scope

New editor features, visual redesign, performance changes without a measured regression, automatic updates, ARM, macOS, Windows, additional package formats, and universal Linux support.

## Further notes

Reversible work is authorized. Pushing, publishing, deployment, and remote issue creation require explicit authorization. Clean profiles on the developer host are not clean supported environments. Missing infrastructure is a release blocker, not a passing test.
