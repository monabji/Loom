# Loom Linux 0.1.0 Beta

This beta provides the Linux x86_64 AppImage for early evaluation. It is not the stable release. The exact candidate passed the mounted Electron suite, saved-data upgrade checks, and separate live Codex and OpenCode journeys on an Omarchy host.

## Download and verify

Download `Loom-0.1.0.AppImage` and `Loom-0.1.0.AppImage.sha256` from the [GitHub beta release](https://github.com/monabji/loom/releases/tag/v0.1.0-beta.1), then verify and launch:

```sh
sha256sum --check Loom-0.1.0.AppImage.sha256
chmod +x Loom-0.1.0.AppImage
./Loom-0.1.0.AppImage
```

SHA-256: `050664bfec7130928fb5c8eb01c5a584198a09067dc96cffcfb24822e055cd47`.

## Known limitations

- Clean Ubuntu 24.04 GNOME Wayland and X11, native desktop integration, and Trash recovery have not been verified.
- The Linux release workflow has not run on GitHub Actions; it is present on the release branch but is not available from the default branch for dispatch.
- On the tested Omarchy host, Electron's native Wayland versus XWayland backend was not established.
- Codex and OpenCode are optional native integrations; install and authenticate them separately.
- Loom has no Linux signing identity or automatic updater. Verify the published checksum before launch.
- Stable release gates and refreshed dependency advisory review remain open. macOS and Windows are not supported by this beta.

See the [installation and backup guide](install.md), [release checklist](README.md), and [security review](security-review.md).
