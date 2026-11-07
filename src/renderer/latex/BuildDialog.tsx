import { createEffect, createMemo, createSignal, untrack, For, Show } from 'solid-js';
import { defaultBuildSettings, type BuildSettings } from '../../contracts/latex';
import type { ProjectWorkspace } from '../editor/documents';
import { Modal } from '../ui/primitives';
import type { LatexWorkspace } from './workspace';
import { pdfIssue, pdfStatus } from './presentation';
import { BuildFeedback } from './BuildFeedback';
export function BuildDialog(props: {
  open: boolean;
  onClose: () => void;
  workspace: ProjectWorkspace;
  latex: LatexWorkspace;
  onCreatePdf: () => void;
  forceMainChoice: boolean;
  onMainChosen: () => void;
  onOpenPaperFolder: () => void;
  onFiles: () => void;
  onFix: () => void;
  fixBusy: boolean;
}) {
  const [settings, setSettings] = createSignal<BuildSettings>(defaultBuildSettings);
  const [saved, setSaved] = createSignal(false);
  const [root, setRoot] = createSignal('');
  const patch = (value: Partial<BuildSettings>) => {
    setSettings((old) => ({ ...old, ...value }));
    setSaved(false);
  };
  const formKey = createMemo(() => (props.open ? (props.workspace.project()?.id ?? 'empty') : ''));
  const settingsReady = createMemo(() => !!props.latex.state());
  createEffect(() => {
    if (!formKey() || !settingsReady()) return;
    untrack(() => {
      setSettings({ ...(props.latex.state()?.settings ?? defaultBuildSettings) });
      setRoot(props.forceMainChoice ? '' : (props.workspace.project()?.rootId ?? ''));
      setSaved(false);
    });
  });
  const changed = () =>
    root() !== (props.workspace.project()?.rootId ?? '') ||
    JSON.stringify(settings()) !==
      JSON.stringify(props.latex.state()?.settings ?? defaultBuildSettings);
  async function save() {
    if (!root()) return false;
    if (root() !== props.workspace.project()?.rootId) {
      const result = await props.workspace.command({ type: 'root', fileId: root() });
      if (!result?.ok) return false;
    }
    const success = await props.latex.configure(settings());
    setSaved(success);
    if (success) props.onMainChosen();
    return success;
  }
  const current = () => props.latex.state()?.current;
  const issue = () => pdfIssue(props.workspace.project(), props.latex.state());
  let setup!: HTMLDetailsElement;
  let mainSelect!: HTMLSelectElement;
  const mainDocument = (id: string) => (
    <label class="main-document-field">
      Main document
      <select
        ref={mainSelect}
        id={id}
        disabled={!settingsReady()}
        aria-label="Main document"
        value={root()}
        onChange={(e) => {
          setRoot(e.currentTarget.value);
          setSaved(false);
        }}
      >
        <option value="">Choose the file that starts your paper</option>
        <For
          each={props.workspace
            .project()
            ?.files.filter((f) => !f.deleted && f.diskKind === 'text' && f.path.endsWith('.tex'))}
        >
          {(file) => <option value={file.id}>{file.path}</option>}
        </For>
      </select>
      <small class="muted">Usually main.tex: the file with your title and document settings.</small>
    </label>
  );
  return (
    <Modal title="PDF settings" icon="fileText" open={props.open} onClose={props.onClose}>
      <div class="pdf-settings-intro">
        <h3>{pdfStatus(props.latex.state(), props.latex.stale())}</h3>
        <p class="muted">
          Loom creates a PDF from your paper. You can keep writing while it works.
        </p>
      </div>
      <Show when={props.latex.error() || props.workspace.error()}>
        <p class="inline-error" role="alert">
          {props.latex.error() || props.workspace.error()}
        </p>
      </Show>
      <Show when={issue()}>
        {(value) => (
          <BuildFeedback
            issue={value()}
            busy={props.workspace.pending() || props.latex.busy()}
            retained={!!props.latex.state()?.successful}
            onFix={props.onFix}
            fixBusy={props.fixBusy}
            onAction={() => {
              if (props.forceMainChoice && value().action === 'retry') {
                mainSelect?.focus();
                return;
              }
              if (value().action === 'folder') props.onOpenPaperFolder();
              else if (value().action === 'setup') {
                setup.open = true;
                setup.scrollIntoView({ block: 'nearest' });
              } else if (value().action === 'main') mainSelect?.focus();
              else if (value().location) {
                props.onClose();
                void props.latex.locate(value().location!);
              } else if (value().action === 'source') props.onFiles();
              else props.onCreatePdf();
            }}
          />
        )}
      </Show>
      <Show when={props.forceMainChoice}>
        <p class="inline-error" role="status">
          This folder has saved settings for a different paper. Choose the main document you want to
          use.
        </p>
      </Show>
      <Show when={!props.workspace.project()?.rootId || props.forceMainChoice}>
        {mainDocument('required-main-document')}
      </Show>
      <label class="checkbox-label auto-pdf-choice">
        <input
          type="checkbox"
          disabled={!settingsReady()}
          checked={settings().autoBuild}
          onChange={(e) => patch({ autoBuild: e.currentTarget.checked })}
        />
        Update the PDF as I write
      </label>
      <p class="muted auto-pdf-help">
        Updates after you pause typing. You can also update it yourself at any time.
      </p>
      <details class="advanced-pdf">
        <summary>Advanced settings</summary>
        <p class="muted">
          The defaults work for most papers. Change these only if your template requires it.
        </p>
        <div class="build-settings">
          <Show when={props.workspace.project()?.rootId && !props.forceMainChoice}>
            {mainDocument('advanced-main-document')}
          </Show>
          <label>
            LaTeX engine
            <select
              disabled={!settingsReady()}
              aria-label="LaTeX engine"
              value={settings().engine}
              onChange={(e) => patch({ engine: e.currentTarget.value as BuildSettings['engine'] })}
            >
              <option value="pdflatex">pdfLaTeX (default)</option>
              <option value="xelatex">XeLaTeX</option>
              <option value="lualatex">LuaLaTeX</option>
            </select>
          </label>
          <label>
            References
            <select
              disabled={!settingsReady()}
              aria-label="References"
              value={settings().bibliography}
              onChange={(e) =>
                patch({ bibliography: e.currentTarget.value as BuildSettings['bibliography'] })
              }
            >
              <option value="auto">Automatic (recommended)</option>
              <option value="bibtex">BibTeX</option>
              <option value="biber">Biber</option>
              <option value="none">Do not process references</option>
            </select>
          </label>
          <label>
            Pause before updating (seconds)
            <input
              type="number"
              min="0.75"
              max="10"
              step="0.25"
              value={settings().delayMs / 1000}
              onChange={(e) =>
                patch({
                  delayMs: Math.round(
                    Math.max(750, Math.min(10000, Number(e.currentTarget.value) * 1000 || 1500)),
                  ),
                })
              }
            />
          </label>
        </div>
        <p class="muted">Settings are saved with this paper and travel with it.</p>
      </details>
      <div class="button-row pdf-settings-actions">
        <button
          class="primary-button"
          disabled={
            props.latex.busy() ||
            props.workspace.pending() ||
            !root() ||
            !settingsReady() ||
            props.latex.running()
          }
          onClick={async () => {
            if (changed() && !(await save())) return;
            props.onMainChosen();
            props.onCreatePdf();
          }}
        >
          {props.latex.state()?.successful ? 'Update PDF' : 'Create PDF'}
        </button>
        <Show when={changed()}>
          <button
            class="secondary-button"
            disabled={props.latex.busy() || !root()}
            onClick={() => void save()}
          >
            Save changes
          </button>
        </Show>
        <Show when={props.latex.running()}>
          <button class="secondary-button" onClick={() => void props.latex.cancel()}>
            Stop
          </button>
        </Show>
        <Show when={saved()}>
          <span role="status">Changes saved</span>
        </Show>
      </div>
      <Show when={props.latex.state()?.queued}>
        <p role="status" class="muted">
          Your latest edits will be included in the next update.
        </p>
      </Show>
      <details ref={setup} class="pdf-setup" open={issue()?.action === 'setup'}>
        <summary>Tools and setup</summary>
        <p>
          PDF creation needs a LaTeX installation on this computer. Install it once, then quit and
          reopen Loom.
        </p>
        <div class="button-row">
          <button class="secondary-button" onClick={() => void window.loom?.openSetup('tex')}>
            LaTeX installation guide ↗
          </button>
          <button class="secondary-button" onClick={() => void props.latex.refresh(true)}>
            Check again
          </button>
        </div>
        <Show when={props.latex.state()} fallback={<p role="status">Checking PDF tools…</p>}>
          <p class="muted">
            {props.latex
              .state()
              ?.tools.filter((tool) => ['latexmk', settings().engine].includes(tool.name))
              .every((tool) => tool.available)
              ? 'The tools for your selected PDF engine are ready.'
              : 'Some PDF tools are missing. The details below identify them for you or someone helping with setup.'}
          </p>
          <details>
            <summary>Tool details</summary>
            <ul class="tool-list">
              <For each={props.latex.state()?.tools}>
                {(tool) => (
                  <li>
                    <strong>{tool.name}</strong>
                    <span>{tool.available ? 'Ready' : 'Not available'}</span>
                    <details>
                      <summary>Version</summary>
                      <pre>{tool.version}</pre>
                    </details>
                  </li>
                )}
              </For>
            </ul>
          </details>
        </Show>
        <details>
          <summary>Writing assistance</summary>
          <p>
            TexLab adds suggestions and navigation in your text. It is optional for PDF creation.
          </p>
          <p class="muted">{props.latex.languageStatus()}</p>
          <button class="secondary-button" onClick={() => void window.loom?.openSetup('texlab')}>
            TexLab installation guide ↗
          </button>
        </details>
      </details>
      <Show when={current()}>
        {(build) => (
          <details class="pdf-technical-details">
            <summary>Technical details</summary>
            <p class="muted">
              {build().root} · {build().settings.engine} · source {build().revision.slice(0, 12)}
            </p>
            <ul class="build-diagnostics">
              <For each={build().diagnostics}>
                {(item) => (
                  <li>
                    <button
                      disabled={!item.path}
                      onClick={() => {
                        if (item.path) {
                          props.onClose();
                          void props.latex.locate({
                            path: item.path,
                            line: item.line,
                            column: item.column,
                          });
                        }
                      }}
                    >
                      {item.path ? `${item.path}:${item.line} · ` : ''}
                      {item.message}
                    </button>
                  </li>
                )}
              </For>
            </ul>
            <details class="build-log">
              <summary>Full LaTeX log</summary>
              <pre>{build().log}</pre>
            </details>
            <details>
              <summary>Recorded tool versions</summary>
              <For each={build().tools.filter((t) => t.available)}>
                {(tool) => (
                  <p class="tool-version">
                    {tool.name}: {tool.version}
                  </p>
                )}
              </For>
              <p class="muted">
                Versions identify the tools used; they do not reproduce the full environment.
              </p>
            </details>
            <button
              class="secondary-button"
              disabled={props.latex.busy() || props.latex.running() || props.forceMainChoice}
              onClick={() => {
                props.onClose();
                void props.latex.compile(true);
              }}
            >
              Rebuild from scratch
            </button>
            <p class="muted">
              The standard latexmk recipe disables custom RC files and shell escape. Settings are
              stored in loom.build.json; executable locations stay on this computer.
            </p>
          </details>
        )}
      </Show>
    </Modal>
  );
}
