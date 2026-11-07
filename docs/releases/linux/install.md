# Install and replace Loom on Linux

Loom is pre-stable. The first stable validation target is Ubuntu 24.04 LTS x86_64 with GNOME Wayland and X11. Neither session is certified until the release checklist contains packaged evidence. Other distributions and architectures are unverified.

## Verify and launch a candidate

Obtain the AppImage and its matching `.sha256` file from the same trusted release source. In the download directory, run:

```sh
sha256sum --check Loom-0.1.0.AppImage.sha256
chmod u+x Loom-0.1.0.AppImage
./Loom-0.1.0.AppImage
```

Replace the filename with the actual candidate version. The checksum must report `OK`. A checksum detects changed bytes; it does not authenticate a publisher. No signing identity or signed release is currently provided.

Run as your normal user in a graphical session. Do not disable Electron sandboxing to work around launch failure. AppImage native mounting requires FUSE support, including `libfuse.so.2` and a working mount helper. Ubuntu 24.04 names its library package `libfuse2t64`; follow the [AppImage FUSE instructions](https://docs.appimage.org/user-guide/troubleshooting/fuse.html) for your distribution. If mounting fails, retain the exact error for the release checklist. Extraction is a diagnostic alternative, not native-launch verification:

```sh
./Loom-0.1.0.AppImage --appimage-extract
./squashfs-root/AppRun
```

Store the extracted directory separately from the project source. Do not extract over an existing installation.

## Start writing

Choose **Create project**, **Open folder**, or **Try a sample paper**. Source editing needs no provider account. PDF compilation requires a local TeX installation with `latexmk` and an engine. Git features require Git. Agents require separately installed and authenticated supported OpenCode or Codex versions; see the root README for the tested version ranges. These tools are not bundled into the AppImage.

A missing tool must leave the source editable and show setup guidance. Review an agent's native permission settings before sending a request. Remote provider processing follows that provider's configuration.

## Add a desktop launcher

The AppImage contains a desktop entry and icon, but automatic installation into the desktop menu is not promised. Keep the binary at a stable absolute path. For manual integration, copy the packaged desktop entry into your user applications directory, change `Exec` to the quoted absolute AppImage path, and change `Icon` to an absolute copy of its icon. Preserve the other entry fields. Use your desktop's launcher editor if available. Never run the AppImage as root.

Clean-target validation must check the menu label, icon, launch, native folder picker, open/reopen, file dialogs, and Trash on both display sessions. A mocked native dialog in a test does not establish desktop integration.

## Back up before replacement

1. Save your work and close every Loom window normally.
2. Copy each project folder, including hidden files, to a separate backup destination.
3. Copy the entire Loom application-data directory, including `metadata.sqlite`, any WAL files, IndexedDB, chats, recovery, and build state. The default Electron directory is `$XDG_CONFIG_HOME/loom`, or `~/.config/loom` when that variable is unset. A custom `--user-data-dir` overrides it. Confirm the actual path used by your installation.
4. Keep the previous binary and its checksum with the backup.

Do not copy an actively changing profile and assume the copy is consistent. Do not delete application data during an upgrade.

## Replace and verify

Close Loom, verify the new checksum, and replace the AppImage at the launcher path. Launch the candidate and confirm the project library, preferences, chats, source, and retained recovery. Open and edit a synthetic project first. There is no automatic updater.

A newer binary may migrate metadata. Older binaries can refuse newer data, and downgrade compatibility is not promised. To roll back, close Loom and restore the backed-up profile together with its matching old binary. Keep the newer profile separately until you confirm recovery. Restore source folders only from the intended backup; do not overwrite newer writing blindly.

## Diagnose display-session failures

Record the OS, desktop, architecture, session type, candidate checksum, and launch error. Wayland and X11 are separate release gates. Do not infer a native Wayland result from a window running through XWayland. GPU, scaling, clipboard, file pickers, and system Trash require actual desktop checks. The release notes list verified environments and known gaps.
