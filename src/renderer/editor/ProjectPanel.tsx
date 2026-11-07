import type { LatexWorkspace } from '../latex/workspace';
import {
  type JSX,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Show,
} from 'solid-js';
import { relativePath, type ProjectFile } from '../../contracts/project';
import type { ProjectWorkspace } from './documents';
import { Modal, IconButton } from '../ui/primitives';
import { ActionMenu, type MenuAction } from '../ui/ActionMenu';
import { Icon, type IconName } from '../ui/Icon';
import { HighlightedText } from '../ui/HighlightedText';

function fileIcon(path: string): IconName {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (['tex', 'ltx', 'sty', 'cls'].includes(ext)) return 'fileText';
  if (ext === 'bib') return 'fileBib';
  if (['png', 'jpg', 'jpeg', 'svg', 'gif', 'pdf', 'eps'].includes(ext)) return 'fileImage';
  return 'file';
}

type FileOperation = { type: 'rename' | 'delete'; id: string; path: string };
export function ProjectPanel(props: {
  workspace: ProjectWorkspace;
  chats?: JSX.Element;
  onNewChat?: () => void;
  latex?: LatexWorkspace;
  onNavigate?: () => void;
  onSettings?: () => void;
  tab?: 'files' | 'chats';
  onTabChange?: (tab: 'files' | 'chats') => void;
}) {
  const w = props.workspace;
  const formId = createUniqueId();
  const [localTab, setLocalTab] = createSignal<'files' | 'chats'>('files');
  const tab = () => props.tab ?? localTab();
  const changeTab = (value: 'files' | 'chats') => {
    setLocalTab(value);
    props.onTabChange?.(value);
  };
  const {
    query,
    setQuery,
    composing,
    setComposing,
    searching,
    error: searchError,
    hits,
    run: searchNow,
  } = w.search;
  const [searchOpen, setSearchOpen] = createSignal(!!query());
  const [operation, setOperation] = createSignal<FileOperation | null>(null);
  const [path, setPath] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [formError, setFormError] = createSignal('');
  const [outlineOpen, setOutlineOpen] = createSignal(true);
  const [recoveryOpen, setRecoveryOpen] = createSignal(false);
  const [recoveryError, setRecoveryError] = createSignal('');
  const [agentInfo, setAgentInfo] = createSignal(false);
  const [collapsed, setCollapsed] = createSignal(new Set<string>());
  let searchInput!: HTMLInputElement;
  let renameInput!: HTMLInputElement;
  let searchToggle!: HTMLButtonElement;
  const files = createMemo(() => new Map(w.project()?.files.map((file) => [file.id, file]) ?? []));
  const deleted = createMemo(() => w.project()?.files.filter((file) => file.deleted) ?? []);
  // Primitive keys preserve row focus across one-second project snapshots.
  const entries = createMemo(() => {
    const result = new Map<string, Set<string>>();
    const add = (directory: string, key: string) => {
      if (!result.has(directory)) result.set(directory, new Set());
      result.get(directory)!.add(key);
    };
    for (const file of files().values()) {
      if (file.deleted) continue;
      const parts = file.path.split('/');
      parts.pop();
      let parent = '';
      for (const part of parts) {
        const folder = parent ? `${parent}/${part}` : part;
        add(parent, `folder:${folder}`);
        parent = folder;
      }
      add(parent, `file:${file.id}`);
    }
    return new Map(
      [...result].map(([directory, keys]) => [
        directory,
        [...keys].sort((a, b) => {
          if (a.startsWith('folder:') !== b.startsWith('folder:'))
            return a.startsWith('folder:') ? -1 : 1;
          const label = (key: string) =>
            key.startsWith('folder:') ? key.slice(7) : (files().get(key.slice(5))?.path ?? '');
          return label(a).localeCompare(label(b), undefined, { numeric: true });
        }),
      ]),
    );
  });
  const activePath = createMemo(() => files().get(w.active())?.path);
  createEffect(() => {
    const value = activePath();
    if (!value) return;
    setCollapsed(
      (previous) => new Set([...previous].filter((folder) => !value.startsWith(`${folder}/`))),
    );
  });
  const clearSearch = () => {
    w.search.clear();
    searchInput?.focus();
  };
  const sections = createMemo(() => {
    w.version();
    const text = w.live(w.active())?.doc.getText('source').toString() ?? w.file()?.text ?? '';
    return [...text.matchAll(/\\(?:sub)*section\*?(?:\[[^\]]*\])?\{([^}]*)\}/g)].map((match) => ({
      title: match[1],
      offset: match.index!,
    }));
  });
  function editFile(type: FileOperation['type'], file: ProjectFile) {
    setOperation({ type, id: file.id, path: file.path });
    setPath(file.path);
    setFormError('');
  }
  async function createFile(directory?: string) {
    const id = await w.newFile(directory);
    if (id) {
      props.onNavigate?.();
      await w.locate(id, 0);
    }
  }
  async function submit() {
    const op = operation();
    if (busy() || !op) return;
    if (op.type === 'rename' && !relativePath.safeParse(path()).success) {
      setFormError('Use a filename or path inside this project, such as sections/results.tex.');
      renameInput.focus();
      return;
    }
    setBusy(true);
    try {
      const result = await w.command(
        op.type === 'rename'
          ? { type: 'rename', fileId: op.id, path: path() }
          : { type: 'delete', fileId: op.id },
      );
      if (result?.ok) setOperation(null);
      else
        setFormError(
          result && !result.ok
            ? result.error.message
            : 'Save pending edits before retrying this action.',
        );
    } finally {
      setBusy(false);
    }
  }
  function FileRow(row: { id: string }) {
    const initial = files().get(row.id)!;
    const file = () => files().get(row.id) ?? initial;
    const actions = (): MenuAction[] => [
      {
        label: 'Rename / move',
        icon: 'edit',
        run: () => editFile('rename', file()),
        disabled: file().conflict,
      },
      {
        label: `Use ${file().path} as root`,
        icon: 'star',
        run: () => void w.command({ type: 'root', fileId: row.id }),
        disabled: !file().path.endsWith('.tex'),
      },
      {
        label: 'Delete',
        icon: 'trash',
        run: () => editFile('delete', file()),
        danger: true,
        disabled: file().conflict,
      },
    ];
    return (
      <li class="file-entry" classList={{ selected: w.active() === row.id }}>
        <button
          class="file-row"
          aria-label={file().path}
          title={file().path}
          aria-description={
            file().conflict
              ? 'External changes need review'
              : w.project()?.rootId === row.id
                ? 'Root document'
                : undefined
          }
          aria-current={w.active() === row.id ? 'true' : undefined}
          onClick={() => {
            props.onNavigate?.();
            void w.select(row.id);
          }}
        >
          <Icon name={fileIcon(file().path)} size={16} />
          <span class="file-name">{file().path.split('/').pop()}</span>
          <Show when={file().conflict}>
            <span class="file-status conflict-status" title="External changes need review">
              Conflict
            </span>
          </Show>
          <Show when={!file().conflict && w.project()?.rootId === row.id}>
            <span class="file-status" title="Root document">
              <Icon name="star" size={12} />
            </span>
          </Show>
        </button>
        <ActionMenu
          label={`Actions for ${file().path}`}
          actions={actions()}
          disabled={w.pending()}
        />
      </li>
    );
  }
  function FolderContents(folder: { directory: string }) {
    return (
      <ul
        class="file-tree"
        aria-label={folder.directory ? `${folder.directory} files` : 'Project files'}
      >
        <For each={entries().get(folder.directory) ?? []}>
          {(key) => (
            <Show when={key.startsWith('folder:')} fallback={<FileRow id={key.slice(5)} />}>
              {(() => {
                const directory = key.slice(7);
                return (
                  <li>
                    <div class="folder-entry">
                      <button
                        class="folder-row"
                        aria-label={`Folder ${directory}`}
                        aria-expanded={!collapsed().has(directory)}
                        onClick={() =>
                          setCollapsed((old) => {
                            const next = new Set(old);
                            next.has(directory) ? next.delete(directory) : next.add(directory);
                            return next;
                          })
                        }
                      >
                        <span
                          class="disclosure-chevron"
                          classList={{ collapsed: collapsed().has(directory) }}
                        >
                          <Icon name="down" size={13} />
                        </span>
                        <Icon name="folder" size={17} />
                        <span class="file-name">{directory.split('/').pop()}</span>
                      </button>
                      <IconButton
                        label={`New file in ${directory}`}
                        icon="plus"
                        disabled={w.pending()}
                        onClick={() => void createFile(directory)}
                      />
                    </div>
                    <Show when={!collapsed().has(directory)}>
                      <FolderContents directory={directory} />
                    </Show>
                  </li>
                );
              })()}
            </Show>
          )}
        </For>
      </ul>
    );
  }
  return (
    <div class="project-panel">
      <Show when={props.onNavigate && w.error()}>
        <p class="panel-error" role="alert">
          {w.error()}
        </p>
      </Show>
      <div class="file-toolbar">
        <div class="tab-buttons" role="group" aria-label="Sidebar content">
          <button
            aria-pressed={tab() === 'files'}
            classList={{ selected: tab() === 'files' }}
            onClick={() => changeTab('files')}
          >
            <Icon name="folder" size={15} />
            Files
          </button>
          <button
            aria-pressed={tab() === 'chats'}
            classList={{ selected: tab() === 'chats' }}
            onClick={() => changeTab('chats')}
          >
            <Icon name="chat" size={15} />
            Chats
          </button>
        </div>
        <Show when={tab() === 'files'}>
          <button
            ref={searchToggle}
            class="icon-button"
            title="Search project"
            aria-label="Search project"
            aria-expanded={searchOpen()}
            onClick={() => {
              setSearchOpen(!searchOpen());
              if (searchOpen()) requestAnimationFrame(() => searchInput?.focus());
              else w.search.clear();
            }}
          >
            <Icon name="search" />
          </button>
          <IconButton
            label="New file"
            icon="plus"
            disabled={w.pending()}
            onClick={() => void createFile()}
          />
          <ActionMenu
            label="Project file options"
            disabled={w.pending()}
            actions={[
              {
                label: 'Delete selected file',
                icon: 'trash',
                danger: true,
                disabled: !w.file() || w.file()?.deleted || w.file()?.conflict,
                run: () => {
                  const file = w.file();
                  if (file && !file.deleted && !file.conflict) editFile('delete', file);
                },
              },
              {
                label: `Deleted files (${deleted().length})`,
                icon: 'restore',
                run: () => {
                  setRecoveryError('');
                  setRecoveryOpen(true);
                },
              },
              {
                label: 'Project settings',
                icon: 'settings',
                run: () => props.onSettings?.(),
                disabled: !props.onSettings,
              },
            ]}
          />
        </Show>
        <Show when={tab() === 'chats'}>
          <IconButton
            label="New conversation"
            icon="plus"
            onClick={() => (props.onNewChat ? props.onNewChat() : setAgentInfo(true))}
          />
        </Show>
      </div>
      <Show
        when={tab() === 'files'}
        fallback={
          props.chats ?? (
            <div class="sidebar-empty chat-empty">
              <Icon name="chat" size={24} />
              <p>No conversations yet</p>
              <span>Connect OpenCode or Codex to discuss your paper.</span>
              <button
                class="text-button"
                onClick={() => (props.onNewChat ? props.onNewChat() : setAgentInfo(true))}
              >
                Agent connection details
              </button>
            </div>
          )
        }
      >
        <Show when={searchOpen()}>
          <div class="search-field project-search-field">
            <Icon name="search" size={15} />
            <input
              ref={searchInput}
              aria-label="Search project text"
              placeholder="Search project…"
              maxLength={500}
              aria-describedby={`${formId}-search-help`}
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={(event) => {
                setQuery(event.currentTarget.value);
                setComposing(false);
              }}
              onKeyDown={(event) => {
                if (event.isComposing || composing()) return;
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void searchNow();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  if (query()) clearSearch();
                  else {
                    setSearchOpen(false);
                    searchToggle.focus();
                  }
                }
              }}
            />
            <Show when={query()}>
              <IconButton label="Clear project search" icon="close" onClick={clearSearch} />
            </Show>
          </div>
          <p class="search-help" id={`${formId}-search-help`}>
            Fuzzy search · filenames and text
          </p>
        </Show>
        <div class="project-browser">
          <Show
            when={query().trim()}
            fallback={
              <Show
                when={entries().size}
                fallback={
                  <div class="sidebar-empty">
                    <p>No files yet</p>
                    <span>Use + to create your first file.</span>
                  </div>
                }
              >
                <FolderContents directory="" />
              </Show>
            }
          >
            <section
              class="search-hits"
              aria-label="Project search results"
              aria-busy={searching()}
            >
              <p class="search-summary" role="status">
                {searching()
                  ? 'Searching…'
                  : `${hits().length === 200 ? 'Top 200' : hits().length} results`}
              </p>
              <Show when={searchError()}>
                <p class="inline-error" role="alert">
                  {searchError()}
                  <button onClick={() => void searchNow()}>Retry search</button>
                </p>
              </Show>
              <For each={hits()}>
                {(hit) => (
                  <button
                    class="search-hit"
                    classList={{ 'is-selected': w.search.selected() === hit }}
                    aria-current={w.search.selected() === hit ? 'location' : undefined}
                    title={`${hit.path}${hit.kind === 'content' ? `:${hit.line}` : ''}`}
                    onClick={() => {
                      props.onNavigate?.();
                      void w.search.navigate(hit);
                    }}
                  >
                    <strong>
                      <HighlightedText text={hit.path} ranges={hit.pathRanges} />
                      {hit.kind === 'content' ? `:${hit.line}` : ''}
                    </strong>
                    <span>
                      <HighlightedText text={hit.snippet} ranges={hit.ranges} />
                    </span>
                    <Show when={hit.approximate}>
                      <small class="search-match-kind">
                        Approximate {hit.kind === 'path' ? 'filename' : 'text'} match
                      </small>
                    </Show>
                  </button>
                )}
              </For>
              <Show when={!searching() && !searchError() && !hits().length}>
                <p class="outline-empty">Try another word or filename.</p>
              </Show>
            </section>
          </Show>
        </div>
        <section
          class="project-outline"
          classList={{ 'is-collapsed': !outlineOpen() }}
          aria-label="Document outline"
        >
          <button
            class="outline-heading"
            aria-expanded={outlineOpen()}
            onClick={() => setOutlineOpen(!outlineOpen())}
          >
            <span class="disclosure-chevron" classList={{ collapsed: !outlineOpen() }}>
              <Icon name="down" size={14} />
            </span>
            Outline
          </button>
          <Show when={outlineOpen()}>
            <div class="outline-list">
              <For
                each={sections()}
                fallback={<p class="outline-empty">No sections in this file.</p>}
              >
                {(section) => (
                  <button
                    class="outline-item"
                    onClick={() => {
                      props.onNavigate?.();
                      void w.locate(w.active(), section.offset);
                    }}
                  >
                    {section.title}
                  </button>
                )}
              </For>
              <Show when={props.latex?.items().length}>
                <details class="project-structure">
                  <summary>Project structure</summary>
                  <For each={props.latex?.items()}>
                    {(item) => (
                      <button
                        class="outline-item"
                        title={`${item.path}:${item.line}`}
                        onClick={() => {
                          props.onNavigate?.();
                          void props.latex?.locate(item);
                        }}
                      >
                        <small>{item.kind} · </small>
                        {item.title}
                        <span class="structure-path">
                          {item.path}:{item.line}
                        </span>
                      </button>
                    )}
                  </For>
                </details>
              </Show>
            </div>
          </Show>
        </section>
      </Show>
      <Modal
        open={operation() !== null}
        title={operation()?.type === 'delete' ? 'Delete file' : 'Rename or move file'}
        initialFocus={operation()?.type === 'delete' ? '.cancel-action' : 'input'}
        onClose={() => {
          if (!busy()) setOperation(null);
        }}
      >
        <form
          novalidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Show
            when={operation()?.type === 'rename'}
            fallback={
              <p>
                Delete <strong>{operation()?.path}</strong>? You can restore it from Deleted files.
              </p>
            }
          >
            <label class="form-field">
              Project-relative path
              <input
                ref={renameInput}
                aria-label="Project-relative path"
                value={path()}
                aria-invalid={!!formError()}
                aria-describedby={formError() ? `${formId}-error` : `${formId}-help`}
                onInput={(event) => {
                  setPath(event.currentTarget.value);
                  setFormError('');
                }}
              />
            </label>
            <p class="help-text" id={`${formId}-help`}>
              Use a folder path to move the file, such as sections/results.tex.
            </p>
          </Show>
          <Show when={formError()}>
            <p role="alert" class="inline-error" id={`${formId}-error`}>
              {formError()}
            </p>
          </Show>
          <div class="modal-actions">
            <button
              type="button"
              class="cancel-action secondary-button"
              disabled={busy()}
              onClick={() => setOperation(null)}
            >
              Cancel
            </button>
            <button
              classList={{
                'danger-button': operation()?.type === 'delete',
                'primary-button': operation()?.type === 'rename',
              }}
              disabled={busy()}
            >
              {busy() ? 'Working…' : operation()?.type === 'delete' ? 'Delete' : 'Rename'}
            </button>
          </div>
        </form>
      </Modal>
      <Modal
        open={recoveryOpen()}
        title="Deleted files"
        onClose={() => {
          if (!busy()) setRecoveryOpen(false);
        }}
      >
        <p class="muted">
          Restore files deleted through Loom. Existing files are never overwritten.
        </p>
        <Show when={recoveryError()}>
          <p class="inline-error" role="alert">
            {recoveryError()}
          </p>
        </Show>
        <For
          each={deleted()}
          fallback={
            <div class="recovery-empty">
              <Icon name="restore" size={28} />
              <p>No deleted files</p>
            </div>
          }
        >
          {(file) => (
            <div class="recovery-row">
              <Icon name={fileIcon(file.path)} />
              <span>{file.path}</span>
              <button
                class="secondary-button"
                aria-label={`Restore ${file.path}`}
                disabled={busy()}
                onClick={async () => {
                  setBusy(true);
                  setRecoveryError('');
                  try {
                    const result = await w.command({ type: 'restore', fileId: file.id });
                    if (!result?.ok)
                      setRecoveryError(
                        result && !result.ok
                          ? result.error.message
                          : 'Save pending edits before restoring.',
                      );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Restore
              </button>
            </div>
          )}
        </For>
      </Modal>
      <Modal open={agentInfo()} title="Agent not connected" onClose={() => setAgentInfo(false)}>
        <p>
          Use the agent connection control below your source to connect OpenCode or Codex and start
          a conversation about this paper.
        </p>
      </Modal>
    </div>
  );
}
