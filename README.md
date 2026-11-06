<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="design/brand/loom-logo-white.svg">
    <img src="design/brand/loom-logo-black.svg" alt="Loom" width="260">
  </picture>
</p>

<p align="center"><strong></strong><br>An AI-native LaTeX editor for research.</p>

![Loom workspace showing a LaTeX source file, assistant composer, and compiled PDF preview](docs/assets/workspace.png)

Loom brings your manuscript, references, PDF preview, and AI agents into one desktop workspace. Make beautiful documents : Write in LaTeX, find and cite research, and work with agents that understand the project around them.

Your paper lives in an ordinary folder of `.tex`, `.bib`, and asset files. Open it in Loom, use it with your existing tools, and collaborate through Git.

## What you can do with Loom :

- **Bring your agents:** Connect OpenCode or Codex (for now) and work with the models available through each harness. Agents use their own authentication, permissions, and tooling, so you can keep the workflows you've already set up.
- **One project, multiple agents:** Connect agents to the same paper and switch between them as you work. Recent conversation context carries across when you switch; Loom runs one agent request at a time per project.
- **Turn errors into context:** Ask an agent to help fix a build error and Loom can include relevant diagnostics and source context with your request.
- **Find research and cite it:** Search arXiv, your local bibliography, and an enabled local Zotero library. Insert citations into your paper and work with BibTeX files alongside your source.
- **Write and see the result:** Edit multi-file projects, build PDFs locally with `latexmk`, and move between your source and the preview using SyncTeX.
- **Collaborate with Git:** Review changes, stage and commit from Loom, or export your project as a portable source archive.
- **Make the workspace yours:** Choose themes and customize the editor to suit how you work.

Agents can write directly to project files according to the permissions selected in their native harness. Review their changes and output. Model availability, authentication, and remote processing depend on the agent and provider you choose.

Loom is in early development. Its desktop build and packaging have been exercised on Linux x86_64; other platforms have not yet been validated.

## Get started

### Requirements

- Linux x86_64 is the currently exercised target.
- Node.js `^22.12.0`, `^24.0.0`, or `>=26.0.0`, with npm 11 or newer. The repository pins npm 11.19.0; CI uses Node.js 26.7.0 and npm 11.19.0.
- Git for cloning and Loom's Git features.
- A local LaTeX installation with `latexmk` and a supported engine (`pdflatex`, `xelatex`, or `lualatex`) to build PDFs. SyncTeX, BibTeX/Biber, and TexLab enable source navigation, bibliography, and language features respectively.
- An optional OpenCode or Codex installation, authenticated separately and connected through **Agent connections**. Supported versions are OpenCode 1.19.x or 2.2.x from 2.2.1, and Codex 0.159.x.

### Run from source

```sh
git clone https://github.com/monabji/loom.git
cd loom
npm ci
npm run dev
```

The development server uses `127.0.0.1:5173`. If the port is occupied, free it or change the renderer port in `electron.vite.config.ts`.

Choose **Create project**, **Open folder**, or **Try a sample paper** to start writing. For PDF features, install the LaTeX tools above or run the following on Linux x86_64:

```sh
npm run setup:latex
```

This downloads a user-local TinyTeX distribution and TexLab under your home directory while preserving existing installations. You can review [the setup script](scripts/setup-latex.mjs) before running it.

## Development

```sh
npm run check       # formatting, type checking, unit tests, and production build
npm run test:e2e    # Electron tests; build first and use a graphical Linux session
npm run package     # build an unpacked Linux application in release/linux-unpacked/
```

Run `npm run build` before the desktop tests. Tests requiring a real TeX installation or an authenticated external provider are opt-in and skipped by default. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, test options, and pull requests.

| Path                          | What lives there                                                       |
| ----------------------------- | ---------------------------------------------------------------------- |
| `src/main`, `src/preload`     | Electron lifecycle and the renderer bridge                             |
| `src/renderer`                | Workspace, editor, PDF, agent, and project UI                          |
| `src/services`                | Project storage, builds, agent integration, Git, and research services |
| `src/contracts`, `src/domain` | Validated contracts and shared domain logic                            |
| `examples`                    | Synthetic LaTeX projects and fixtures                                  |
| `tests`                       | Unit, integration, and Electron tests                                  |
| `design/brand`                | Loom logo, icons, and font attribution                                 |

## Contributing

Issues, documentation improvements, bug fixes, and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and follow the [Code of Conduct](CODE_OF_CONDUCT.md). To report a vulnerability, follow [SECURITY.md](SECURITY.md).

## License

Loom's source code is available under the [MIT License](LICENSE). Third-party assets may have separate terms; see the [brand assets](design/brand/README.md), [bundled font license](design/brand/fonts/OFL.txt), and [provider mark attribution](src/renderer/ui/provider-assets/README.md).
