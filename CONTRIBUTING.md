# Contributing to Loom

Thanks for helping improve Loom. Bug reports, documentation, accessibility fixes, tests, and code contributions are all welcome.

For a substantial feature or a change to existing behavior, open an issue first so the approach can be discussed. For smaller fixes, a pull request is welcome directly.

## Set up a development copy

1. Fork and clone the repository.
2. Install a supported Node.js version and npm 11 or newer. Node.js 26.7.0 and npm 11.19.0 match CI.
3. Run `npm ci`, then `npm run dev`.
4. Create a project or open one of the synthetic examples under `examples/`.

PDF builds need a local TeX installation and `latexmk`. OpenCode and Codex are optional and require their own installation and authentication. See the [README](README.md#get-started) for details.

## Make a change

- Create a branch for your work and keep the change focused.
- Follow the existing TypeScript, SolidJS, Electron, and formatting conventions.
- Keep native operations behind the existing validated contracts. Preserve ordinary source files, unsaved work, and recovery data.
- Use synthetic fixtures. Never include personal manuscripts, credentials, private agent transcripts, or confidential logs in issues, tests, or screenshots.
- Add or update tests when they help verify behavior or a regression. For UI work, check keyboard access and a smaller desktop window.

## Check your work

Run the standard checks before opening a pull request:

```sh
npm run check
```

This runs formatting, TypeScript checks, unit tests, and a production build. CI runs the same command on Linux. Some tests are intentionally skipped unless a real TeX toolchain or an authenticated external provider is explicitly enabled.

For desktop behavior, run the Electron suite in a graphical Linux session:

```sh
npm run build
npm run test:e2e
```

For a focused test, use the underlying runner, for example `npx vitest run tests/builds.test.ts` or `npx playwright test tests/e2e/latex.spec.ts`. Real local TeX checks can be enabled with `LOOM_TEST_TEX=1`; live provider tests require their corresponding opt-in environment variable and your own authorized account. Do not enable live tests in shared CI or use another person's credentials.

## Open a pull request

Open contribution pull requests against the `staging` branch, not `main`. GitHub defaults new pull requests to `main`, so change the base branch to `staging` in the pull request form before submitting. The `staging` branch is for integrating and checking contributions; `main` remains the stable default branch.

GitHub's Contributors graph is based on commits in the default branch (`main`). Commits merged into `staging` do not appear there unless they are later brought into `main`.

Describe the problem, the change, and how you tested it. Include screenshots for visible UI changes and note any platform or external-service checks you could not run. Link a related issue when there is one.

By contributing, you confirm that you have the right to submit your work under the repository's [MIT License](LICENSE). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).
