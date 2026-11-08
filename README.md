<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="design/brand/loom-logo-white.svg">
    <img src="design/brand/loom-logo-black.svg" alt="Loom" width="260">
  </picture>
</p>

<p align="center">A LaTeX editor with AI agents for research.</p>

![Loom workspace showing a LaTeX source file, assistant composer, and compiled PDF preview](docs/assets/workspace.png)

Write your paper, manage references, and preview the PDF in one desktop workspace. Connect OpenCode or Codex to help edit your project and resolve build errors.

Your project is an ordinary folder of `.tex`, `.bib`, and asset files. You can use the same files with other editors and collaborate through Git.

## Work on your paper

- Edit multi-file LaTeX projects, compile PDFs with `latexmk`, and move between source and preview with SyncTeX.
- Search arXiv, your bibliography, or an enabled local Zotero library. Insert citations and edit BibTeX files alongside your paper.
- Connect OpenCode or Codex with its own models, authentication, tools, and permissions. Switch agents with recent conversation context carried across. Loom runs one agent request at a time per project.
- Send build diagnostics and relevant source context to an agent when you need help with an error.
- Review changes, stage and commit with Git, or export a source archive.
- Choose a theme and customize the editor.

Agents can change project files under the permissions you select in OpenCode or Codex. Review their changes. Your agent and provider settings determine model availability and remote processing.

## Get started

Loom is in early development. The Linux x86_64 beta has been tested on an Omarchy host. Clean Ubuntu GNOME Wayland and X11 sessions, desktop integration, and other platforms remain unverified. See the [Linux release checklist](docs/releases/linux/README.md) for the recorded checks and remaining work.

### Install the Linux beta

Download the AppImage and matching `.sha256` file from the [Loom Linux 0.1.0 Beta release](https://github.com/monabji/loom/releases/tag/v0.1.0-beta.1). In the download directory, run:

```sh
sha256sum --check Loom-0.1.0.AppImage.sha256
chmod u+x Loom-0.1.0.AppImage
./Loom-0.1.0.AppImage
```

Confirm that the checksum reports `OK` before launching. The AppImage needs FUSE support. See the [Linux installation guide](docs/releases/linux/install.md) for launch troubleshooting, desktop launchers, backups, and upgrades.

### Run from source

Install Git, Node.js, and npm 11 or newer. Supported Node.js versions are `^22.12.0`, `^24.0.0`, or `>=26.0.0`. To match CI, use Node.js 26.7.0 and npm 11.19.0.

```sh
git clone https://github.com/monabji/loom.git
cd loom
npm ci
npm run dev
```

The development server uses `127.0.0.1:5173`. If that port is occupied, free it or change the renderer port in `electron.vite.config.ts`.

### Open a paper and build a PDF

Choose **Create project**, **Open folder**, or **Try a sample paper**. You can edit source files without an agent account or a LaTeX installation.

To compile PDFs, install LaTeX with `latexmk` and an engine such as `pdflatex`, `xelatex`, or `lualatex`. SyncTeX enables source navigation, BibTeX or Biber handles bibliographies, and TexLab provides language features.

If you cloned the repository, you can install the LaTeX tools on Linux x86_64 with:

```sh
npm run setup:latex
```

The [setup script](scripts/setup-latex.mjs) downloads TinyTeX and TexLab into your home directory and preserves existing installations. Git features require a separate Git installation.

### Connect an agent

Install and authenticate OpenCode or Codex separately, then connect it through **Agent connections** in Loom. Supported versions are OpenCode 1.19.x or 2.2.x from 2.2.1, and Codex 0.159.x. The AppImage does not bundle these tools.

## Development

Loom uses Electron, SolidJS, and TypeScript. For setup, test options, and contribution rules, read [CONTRIBUTING.md](CONTRIBUTING.md).

Run the standard checks:

```sh
npm run check
```

This checks formatting and types, runs unit and Linux release tests, and builds the app. Tests that need a real TeX installation or an authenticated provider are opt-in.

To run the Electron tests in a graphical Linux session:

```sh
npm run build
npm run test:e2e
```

To build an unpacked Linux app in `release/linux-unpacked/`:

```sh
npm run package
```

## Contributing

Report bugs, suggest changes, or submit a pull request. Read [CONTRIBUTING.md](CONTRIBUTING.md) before you start and follow the [Code of Conduct](CODE_OF_CONDUCT.md). Send contribution pull requests to `staging`.

To report a vulnerability, follow [SECURITY.md](SECURITY.md).

## License

Loom's source code uses the [MIT License](LICENSE). Third-party assets have their own terms. See the [brand assets](design/brand/README.md), [font license](design/brand/fonts/OFL.txt), and [provider mark attribution](src/renderer/ui/provider-assets/README.md).
