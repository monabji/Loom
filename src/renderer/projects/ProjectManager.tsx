import { LoomLogo } from '../ui/LoomLogo';
import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { ProjectChoice, RecentProject } from '../../contracts/project';
import { ActionMenu } from '../ui/ActionMenu';
import { Icon } from '../ui/Icon';
import { EmptyState, IconButton, Modal } from '../ui/primitives';

export function ProjectManager(props: {
  pending: boolean;
  error: string;
  current?: string;
  onContinue: () => void;
  onCloseProject?: () => Promise<void>;
  onChoose: (choice: ProjectChoice) => void;
  onOpen: (id: string) => Promise<void>;
  onAppearance: () => void;
  onMore: () => void;
  onSettings: () => void;
  onService: () => void;
  serviceLabel: string;
}) {
  const [entries, setEntries] = createSignal<RecentProject[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [removal, setRemoval] = createSignal<RecentProject | null>(null);
  const [removing, setRemoving] = createSignal(false);
  const [removalError, setRemovalError] = createSignal('');
  const busy = () => props.pending || removing();
  const [query, setQuery] = createSignal('');
  const [view, setView] = createSignal<'list' | 'grid'>('list');
  const [sort, setSort] = createSignal<'recent' | 'name'>('recent');
  let input!: HTMLInputElement;
  let disposed = false;
  let generation = 0;
  const refresh = async () => {
    const request = ++generation;
    setLoading(true);
    setError('');
    try {
      if (!window.loom) {
        setError('Open Loom on your desktop to access local projects.');
        return;
      }
      const result = await window.loom.project({ type: 'library' });
      if (disposed || request !== generation) return;
      if (result.ok && result.library) setEntries(result.library);
      else
        setError(result.ok ? 'The local project library could not be read.' : result.error.message);
    } catch {
      if (!disposed && request === generation)
        setError('The local project library is unavailable. Retry to reconnect.');
    } finally {
      if (!disposed && request === generation) setLoading(false);
    }
  };
  onMount(() => {
    try {
      const saved = localStorage.getItem('loom.project-library.v1');
      if (saved === 'grid') setView('grid');
    } catch {
      /* Default view remains usable. */
    }
    void refresh();
    const unsubscribe = window.loom?.onServiceEvent((event) => {
      if (event.status.state === 'ready') void refresh();
    });
    onCleanup(() => {
      disposed = true;
      unsubscribe?.();
    });
  });
  const remove = async () => {
    const entry = removal();
    if (!entry || removing()) return;
    setRemoving(true);
    setRemovalError('');
    try {
      const result = await window.loom!.project({
        type: entry.available ? 'trash-project' : 'forget-project',
        projectId: entry.id,
      });
      if (!result.ok) setRemovalError(result.error.message);
      else {
        setEntries(result.library ?? []);
        setRemoval(null);
        document.getElementById('library-heading')?.focus();
      }
    } catch {
      setRemovalError('Project removal was interrupted. Refresh the library before retrying.');
    } finally {
      setRemoving(false);
    }
  };
  const setMode = (mode: 'list' | 'grid') => {
    setView(mode);
    try {
      localStorage.setItem('loom.project-library.v1', mode);
    } catch {
      setError('Your view changed, but could not be saved on this device.');
    }
  };
  const filtered = createMemo(() => {
    const needle = query().trim().toLocaleLowerCase();
    return entries()
      .filter((p) => `${p.name} ${p.path}`.toLocaleLowerCase().includes(needle))
      .sort((a, b) =>
        sort() === 'name'
          ? a.name.localeCompare(b.name)
          : b.lastOpened - a.lastOpened || a.name.localeCompare(b.name),
      );
  });
  const clear = () => {
    setQuery('');
    input.focus();
  };
  const openedDate = (entry: RecentProject) =>
    entry.lastOpened
      ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(
          entry.lastOpened,
        )
      : 'Previously opened';
  return (
    <div class="project-manager">
      <aside class="library-sidebar" aria-label="Project library">
        <div class="library-brand">
          <LoomLogo />
        </div>
        <nav aria-label="Projects">
          <p class="muted">On this device</p>
          <button
            class="library-nav"
            disabled={busy()}
            aria-current="page"
            onClick={() => {
              setQuery('');
              if (!busy()) void refresh();
            }}
          >
            <Icon name="folder" />
            Your projects
          </button>
        </nav>
        <div class="library-local">
          <Icon name="monitor" size={18} />
          <div>
            Local workspace<small>Saved on this computer</small>
          </div>
        </div>
        <div class="library-settings">
          <button disabled={busy()} onClick={props.onMore}>
            Project options
          </button>
        </div>
      </aside>
      <main class="library-main" aria-labelledby="library-heading" aria-busy={loading() || busy()}>
        <header class="library-toolbar">
          <h1 id="library-heading" tabIndex={-1}>
            Your projects
          </h1>
          <div class="library-actions">
            <div class="library-search">
              <Icon name="search" size={19} />
              <input
                ref={input}
                aria-label="Search projects"
                placeholder="Search projects"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
              />
              <Show when={query()}>
                <IconButton label="Clear project search" icon="close" onClick={clear} />
              </Show>
            </div>
            <div class="library-views" role="group" aria-label="Project view">
              <IconButton
                label="List view"
                icon="list"
                active={view() === 'list'}
                onClick={() => setMode('list')}
              />
              <IconButton
                label="Grid view"
                icon="tools"
                active={view() === 'grid'}
                onClick={() => setMode('grid')}
              />
            </div>
            <button
              class="secondary-button library-open"
              disabled={busy()}
              onClick={() => props.onChoose('open')}
            >
              <Icon name="folder" size={18} />
              Open folder
            </button>
            <ActionMenu
              label="Import project"
              icon="download"
              disabled={busy()}
              actions={[
                {
                  label: 'Import folder',
                  icon: 'folder',
                  run: () => props.onChoose('import-folder'),
                },
                { label: 'Import ZIP', icon: 'file', run: () => props.onChoose('import-zip') },
              ]}
            />
            <button
              class="primary-button library-new"
              disabled={busy()}
              onClick={() => props.onChoose('create')}
            >
              <Icon name="plus" size={19} />
              New project
            </button>
          </div>
        </header>
        <div class="library-subheader">
          <span role="status">
            {loading()
              ? 'Loading projects…'
              : props.pending
                ? 'Opening project…'
                : `${filtered().length} ${filtered().length === 1 ? 'project' : 'projects'}`}
          </span>
          <button
            onClick={() => setSort(sort() === 'recent' ? 'name' : 'recent')}
            aria-label={
              sort() === 'recent' ? 'Sort projects by name' : 'Sort projects by last opened'
            }
          >
            {sort() === 'recent' ? 'Last opened' : 'Name'}
            <Icon name="down" size={14} />
          </button>
          <IconButton
            label="Refresh projects"
            icon="refresh"
            disabled={loading() || busy()}
            onClick={() => void refresh()}
          />
        </div>
        <Show when={error() || props.error}>
          <div class="library-error" role="alert">
            {error() || props.error}
            <button
              class="text-button"
              disabled={loading() || busy()}
              onClick={() => void refresh()}
            >
              Refresh library
            </button>
          </div>
        </Show>
        <Show when={props.current}>
          <div class="library-resume">
            <span>{props.current} is open</span>
            <button class="text-button" disabled={busy()} onClick={props.onContinue}>
              Return to workspace
              <Icon name="chevron" size={16} />
            </button>
            <Show when={props.onCloseProject}>
              <button
                class="text-button"
                disabled={busy()}
                onClick={() => {
                  setRemoving(true);
                  void props.onCloseProject!()
                    .then(() => refresh())
                    .catch(() =>
                      setError(
                        'Could not close the project. Save changes and stop active work before retrying.',
                      ),
                    )
                    .finally(() => setRemoving(false));
                }}
              >
                Close project
              </button>
            </Show>
          </div>
        </Show>
        <div class="library-content">
          <Show when={!loading() && !error() && !entries().length}>
            <EmptyState icon="folder" title="A place for your next paper">
              <p>Create a LaTeX project or open a folder you already use.</p>
              <p>Your writing, chats and working state stay on this computer.</p>
              <div class="button-row">
                <button
                  class="primary-button"
                  disabled={busy()}
                  onClick={() => props.onChoose('create')}
                >
                  Create project
                </button>
                <button
                  class="secondary-button"
                  disabled={busy()}
                  onClick={() => props.onChoose('open')}
                >
                  Open existing project
                </button>
              </div>
              <button
                class="text-button"
                disabled={busy()}
                onClick={() => props.onChoose('sample')}
              >
                Try a sample paper
              </button>
            </EmptyState>
          </Show>
          <Show when={!loading() && entries().length && !filtered().length}>
            <EmptyState icon="search" title="No matching projects">
              <p>Try another name or folder path.</p>
              <button class="secondary-button" onClick={clear}>
                Clear search
              </button>
            </EmptyState>
          </Show>
          <Show when={filtered().length > 0}>
            <ul class={`library-projects library-${view()}`} aria-label="Saved projects">
              <For each={filtered()}>
                {(entry) => (
                  <li class="library-project-row">
                    <button
                      class="library-project"
                      disabled={busy()}
                      onClick={() => void props.onOpen(entry.id)}
                      aria-label={`Open ${entry.name}`}
                    >
                      <span class="library-document" aria-hidden="true">
                        <Icon name="fileText" size={30} />
                      </span>
                      <span class="library-project-info">
                        <strong>{entry.name}</strong>
                        <span class="library-path" title={entry.path}>
                          {entry.path}
                        </span>
                        <Show when={!entry.available}>
                          <span class="library-missing">
                            Folder unavailable · Reconnect or restore its folder
                          </span>
                        </Show>
                      </span>
                      <span class="library-date">{openedDate(entry)}</span>
                      <Icon name="chevron" size={17} />
                    </button>
                    <ActionMenu
                      label={`Options for ${entry.name}`}
                      disabled={busy() || loading()}
                      actions={[
                        {
                          label:
                            entry.deleteBlockedReason ??
                            (entry.available ? 'Move project to Trash' : 'Remove from list'),
                          icon: 'trash',
                          danger: true,
                          disabled: !!entry.deleteBlockedReason,
                          run: () => {
                            setRemovalError('');
                            setRemoval(entry);
                          },
                        },
                      ]}
                    />
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
        <footer class="library-footer">
          <Icon name="lock" size={14} />
          <span>Local projects · No account required</span>
          <button class="text-button" disabled={busy()} onClick={props.onService}>
            {props.serviceLabel}
          </button>
          <IconButton
            disabled={busy()}
            label="Workspace settings"
            icon="settings"
            onClick={props.onSettings}
          />
          <button class="text-button" disabled={busy()} onClick={props.onAppearance}>
            Appearance
          </button>
          <button class="text-button" disabled={busy()} onClick={props.onMore}>
            More options
          </button>
        </footer>
      </main>
      <Modal
        title={removal()?.available ? 'Move project to Trash?' : 'Remove project from list?'}
        open={!!removal()}
        onClose={() => {
          if (!removing()) setRemoval(null);
        }}
        initialFocus=".cancel-project-removal"
        icon="trash"
      >
        <Show when={removal()}>
          {(entry) => (
            <>
              <p>
                <strong>{entry().name}</strong>
              </p>
              <p class="library-removal-path">{entry().path}</p>
              <p>
                {entry().available
                  ? 'The entire project folder and all files inside will move to system Trash. You can restore it there, then use Open folder to reopen it. Loom will retain its recovery data.'
                  : 'This folder is unavailable. Only its library entry will be removed. Loom will retain recovery data; restore the folder and use Open folder to reopen it.'}
              </p>
              <Show when={removalError()}>
                <p role="alert">{removalError()}</p>
              </Show>
              <div class="button-row">
                <button
                  class="secondary-button cancel-project-removal"
                  disabled={removing()}
                  onClick={() => setRemoval(null)}
                >
                  Cancel
                </button>
                <button class="danger-button" disabled={removing()} onClick={() => void remove()}>
                  {removing()
                    ? 'Removing…'
                    : entry().available
                      ? 'Move to Trash'
                      : 'Remove from list'}
                </button>
              </div>
            </>
          )}
        </Show>
      </Modal>
    </div>
  );
}
