import { LoomLogo } from '../ui/LoomLogo';
import { ProjectManager } from '../projects/ProjectManager';
import '../projects/projects.css';
import { AppearanceDialog, createAppearance } from '../appearance/Appearance';
import { References } from '../references/References';
import {
  AgentChanges,
  AgentDiff,
  pendingChanges,
  selectedChange,
  type ChangeSelection,
} from '../agent/AgentChanges';
import { createAgentChangePreview } from '../agent/changePreview';
import { createAgentWorkspace } from '../agent/workspace';
import {
  AgentChats,
  AgentComposer,
  AgentConnections,
  AgentConversation,
  AgentImagePreview,
} from '../agent/AgentSurface';
import { createLatexWorkspace } from '../latex/workspace';
import { BuildDialog } from '../latex/BuildDialog';
import { BuildFeedback } from '../latex/BuildFeedback';
import { pdfIssue, pdfStatus } from '../latex/presentation';
import type { ProjectChoice } from '../../contracts/project';
import { PdfViewer } from '../latex/PdfViewer';
import { createProjectWorkspace } from '../editor/documents';
import { SourceEditor } from '../editor/SourceEditor';
import { ProjectPanel } from '../editor/ProjectPanel';
import {
  untrack,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';
import type { LoomDesktop, ServiceStatus } from '../../contracts/desktop';
import { Icon } from '../ui/Icon';
import { ActionMenu } from '../ui/ActionMenu';
import { EmptyState, IconButton, Modal } from '../ui/primitives';
import { defaultLayout, loadLayout, saveLayout, type Layout } from './layout';
import { exampleSource, tokenize } from './example';
import { imageMime } from '../../domain/images';
import { GitWorkspace } from '../git/GitWorkspace';
import type { GitStatus } from '../../contracts/git';

declare global {
  interface Window {
    loom?: LoomDesktop;
  }
}
type Dialog =
  'files' | 'projects' | 'tools' | 'settings' | 'availability' | 'service' | 'build' | null;
export function Workspace() {
  const layoutStorage = {
    getItem: (key: string) => window.localStorage.getItem(key),
    setItem: (key: string, value: string) => window.localStorage.setItem(key, value),
  };
  const appearance = createAppearance();
  const [appearanceOpen, setAppearanceOpen] = createSignal(false);
  const initial = loadLayout(layoutStorage);
  const [layout, setLayout] = createSignal(initial.layout);
  const [notice, setNotice] = createSignal(initial.warning ?? '');
  const [noticePaused, setNoticePaused] = createSignal(false);
  createEffect(() => {
    if (!notice() || noticePaused()) return;
    const timer = setTimeout(() => setNotice(''), 5000);
    onCleanup(() => clearTimeout(timer));
  });
  const [libraryOpen, setLibraryOpen] = createSignal(true);
  const projects = createProjectWorkspace(setNotice, { libraryFirst: true });
  const [returningToLibrary, setReturningToLibrary] = createSignal(false);
  let navigationTransition: ViewTransition | undefined;
  function navigateLibrary(open: boolean) {
    navigationTransition?.skipTransition();
    layoutTransition?.skipTransition();
    // Close the chooser now; a following PDF/setup dialog must survive the async update.
    setDialog(null);
    const previous = document.activeElement;
    const apply = () => setLibraryOpen(open);
    const focusDestination = () =>
      requestAnimationFrame(() => {
        if (
          libraryOpen() !== open ||
          (document.activeElement !== previous && document.activeElement !== document.body)
        )
          return;
        const target = open
          ? document.querySelector<HTMLElement>('#library-heading')
          : effectiveMode() === 'pdf'
            ? pdf
            : (document.querySelector<HTMLElement>('.cm-content') ?? source);
        target?.focus({ preventScroll: true });
      });
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const transition = document.startViewTransition({
        types: ['project-navigation', open ? 'project-return' : 'project-open'],
        update: apply,
      });
      navigationTransition = transition;
      void transition.ready.catch(() => {});
      void transition.updateCallbackDone.then(focusDestination).catch(() => {});
      void transition.finished
        .catch(() => {})
        .finally(() => {
          if (navigationTransition === transition) navigationTransition = undefined;
        });
    } else {
      apply();
      focusDestination();
    }
  }
  onCleanup(() => navigationTransition?.skipTransition());
  const showLibrary = async () => {
    if (returningToLibrary()) return;
    setReturningToLibrary(true);
    try {
      if (await projects.saveSession()) navigateLibrary(true);
    } finally {
      setReturningToLibrary(false);
    }
  };
  const BackToProjects = () => (
    <button
      class="workspace-back"
      aria-label="Back to projects"
      title="Back to projects"
      disabled={returningToLibrary() || projects.pending()}
      aria-busy={returningToLibrary()}
      onClick={() => void showLibrary()}
    >
      <Icon name="back" size={16} />
      <span>Projects</span>
    </button>
  );
  const latex = createLatexWorkspace(projects, setNotice);
  const agent = createAgentWorkspace(projects, setNotice, () => ({
    activeFile: projects.file()?.path,
    editorDiagnostics: latex.editorDiagnostics(),
    errors: [
      { source: 'editor' as const, message: projects.error() },
      { source: 'pdf' as const, message: latex.error() },
      { source: 'service' as const, message: serviceError() },
    ]
      .filter((item) => item.message)
      .map((item) => ({ ...item, message: item.message.slice(0, 2000) })),
  }));
  const [chatHeight, setChatHeight] = createSignal(68);
  const resizeChat = (height: number) => setChatHeight(Math.max(40, Math.min(82, height)));
  const [referencesOpen, setReferencesOpen] = createSignal(false);
  const [gitOpen, setGitOpen] = createSignal(false);
  const [gitStatus, setGitStatus] = createSignal<GitStatus | null>(null);
  const [cloneUrl, setCloneUrl] = createSignal('');
  const [cloneBusy, setCloneBusy] = createSignal(false);
  const [cloneError, setCloneError] = createSignal('');
  const cloneFromChooser = async () => {
    const url = cloneUrl().trim();
    if (!url || !window.loom) return;
    if (!(await projects.saveSession())) return;
    setCloneBusy(true);
    setCloneError('');
    const result = await window.loom.cloneGit({ url });
    setCloneBusy(false);
    if (!result.ok) {
      setCloneError(result.error.message);
      return;
    }
    if (result.value) {
      setCloneUrl('');
      await projects.command({ type: 'current' });
      setDialog(null);
      navigateLibrary(false);
    }
  };
  let gitProjectId: string | undefined;
  createEffect(() => {
    const id = projects.project()?.id;
    if (id !== gitProjectId) setGitStatus(null);
    gitProjectId = id;
  });
  const [connectionsOpen, setConnectionsOpen] = createSignal(false);
  const [newChatProject, setNewChatProject] = createSignal<string | null>(null);
  const [chatBeforeReview, setChatBeforeReview] = createSignal<number | null>(null);
  const [reviewSelection, setReviewSelection] = createSignal<ChangeSelection | null>(null);
  const [undoChanges, setUndoChanges] = createSignal<ChangeSelection[] | null>(null);
  const reviewChange = () => selectedChange(agent, reviewSelection());
  const selectReview = (selection: ChangeSelection) => {
    if (!reviewSelection()) setChatBeforeReview(chatHeight());
    setReviewSelection(selection);
    agent.setOpen(true);
    setChatHeight(45);
    const file = projects
      .project()
      ?.files.find((file) => file.path === selection.path && !file.deleted);
    if (file) void projects.select(file.id);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.agent-source-diff')?.focus());
  };
  const openReview = () => {
    const entry = pendingChanges(agent).at(-1);
    if (entry) selectReview({ turnId: entry.turnId, path: entry.change.path });
  };
  const reviewProject = createMemo(() => projects.project()?.id);
  createEffect(() => {
    reviewProject();
    setReviewSelection(null);
    setUndoChanges(null);
  });
  const closeReview = () => {
    if (chatBeforeReview() !== null) setChatHeight(chatBeforeReview()!);
    setChatBeforeReview(null);
    setReviewSelection(null);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.cm-content')?.focus());
  };
  const keepReview = async () => {
    const target = reviewSelection();
    if (target && (await agent.review(target.turnId, target.path, 'keep'))) closeReview();
  };
  const agentConnect = () => {
    setNewChatProject(null);
    setConnectionsOpen(true);
  };
  const newChat = () => {
    const projectId = projects.project()?.id;
    if (!projectId || agent.busy()) return;
    if (agent.state()?.running) {
      agent.setError('Stop the current request before starting a new conversation.');
      agent.setOpen(true);
      return;
    }
    if (agent.state()?.connection === 'connected') {
      void agent.newChat().then((ok) => {
        if (ok)
          requestAnimationFrame(() =>
            document.querySelector<HTMLTextAreaElement>('.agent-prompt')?.focus(),
          );
      });
    } else {
      setNewChatProject(projectId);
      setConnectionsOpen(true);
    }
  };
  const [pdfPosition, setPdfPosition] = createSignal({ page: 1, zoom: 1, scroll: 0 });
  const pdfProjectIdentity = createMemo(() => projects.project()?.id);
  createEffect(() => {
    pdfProjectIdentity();
    setPdfPosition({ page: 1, zoom: 1, scroll: 0 });
  });
  const [example, setExample] = createSignal(false);
  const [sampleHint, setSampleHint] = createSignal(false);
  const [dialog, setDialog] = createSignal<Dialog>(null);
  function prepareScientificRequest(instruction: string, notice: string) {
    const draft = [agent.draft(), instruction].filter(Boolean).join('\n\n');
    if (draft.length > 50000) {
      setNotice('The assistant draft is full. Shorten it before adding a scientific request.');
      return;
    }
    const file = projects.file();
    const caret = file ? projects.caret(file.id) : undefined;
    let selectionNotice = '';
    if (caret && caret.anchor !== caret.head) {
      if (agent.selection())
        selectionNotice =
          ' The previously attached passage was retained; the current selection was not attached.';
      else if (!agent.attachSelection())
        selectionNotice =
          ' The current selection could not be attached; check the assistant message.';
    }
    agent.setDraft(draft);
    agent.setOpen(true);
    setDialog(null);
    setNotice(notice + selectionNotice);
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>('.agent-prompt')?.focus(),
    );
  }
  const chooseMain = latex.mainChoiceRequired;
  const setChooseMain = latex.setMainChoiceRequired;
  const [availability, setAvailability] = createSignal({ title: '', detail: '' });
  const [query, setQuery] = createSignal('');
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [narrow, setNarrow] = createSignal(window.innerWidth < 1100);
  const [service, setService] = createSignal<ServiceStatus>({
    state: 'starting',
    pid: null,
    version: '0.1.0',
  });
  const [serviceError, setServiceError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  let source!: HTMLElement;
  let pdf!: HTMLElement;
  let previewToggle!: HTMLButtonElement;
  let search!: HTMLInputElement;
  let shell!: HTMLDivElement;
  let dragCleanup: (() => void) | undefined;
  let layoutTransition: ViewTransition | undefined;
  const update = (patch: Partial<Layout>) => {
    const apply = () => setLayout((old) => ({ ...old, ...patch }));
    const changesVisibility = 'sidebarOpen' in patch || 'pdfOpen' in patch || 'mode' in patch;
    if (
      changesVisibility &&
      document.startViewTransition &&
      !matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      layoutTransition?.skipTransition();
      layoutTransition = document.startViewTransition(apply);
    } else apply();
  };
  const effectiveMode = () => (narrow() && layout().mode === 'split' ? 'source' : layout().mode);
  const sidebarVisible = () => layout().sidebarOpen && !narrow() && effectiveMode() === 'split';
  const sourceVisible = () => effectiveMode() !== 'pdf';
  const pdfVisible = () =>
    effectiveMode() === 'pdf' || (effectiveMode() === 'split' && layout().pdfOpen);
  const columns = () =>
    [
      sidebarVisible() ? `${layout().sidebar}fr 6px` : '',
      sourceVisible()
        ? `${100 - (sidebarVisible() ? layout().sidebar : 0) - (pdfVisible() ? layout().pdf : 0)}fr`
        : '',
      sourceVisible() && pdfVisible() ? '6px' : '',
      pdfVisible() ? `${sourceVisible() ? layout().pdf : 100}fr` : '',
    ]
      .filter(Boolean)
      .join(' ');
  const showUnavailable = (title: string, detail: string) => {
    setAvailability({ title, detail });
    setDialog('availability');
  };
  const showExample = () => {
    setExample(true);
    navigateLibrary(false);
    setNotice('Read-only example loaded. No project files were created.');
  };
  const afterLayout = (action: () => void) => {
    if (layoutTransition)
      void layoutTransition.updateCallbackDone.then(() => requestAnimationFrame(action));
    else requestAnimationFrame(action);
  };
  const focusMode = (mode: Layout['mode']) => {
    const previous = document.activeElement;
    update({ mode });
    afterLayout(() => {
      // A later keyboard/pointer action owns focus; do not steal it from a menu.
      if (document.activeElement === previous || document.activeElement === document.body)
        (mode === 'pdf' ? pdf : source)?.focus();
    });
  };
  const togglePreview = () => {
    const open = !pdfVisible();
    update({ pdfOpen: open, mode: open && narrow() ? 'pdf' : 'split' });
    afterLayout(() => {
      if (!open) previewToggle?.focus();
      else if (narrow()) pdf?.focus();
    });
  };
  const issue = () => pdfIssue(projects.project(), latex.state());
  const [dismissedPdfIssue, setDismissedPdfIssue] = createSignal('');
  // Polling replaces state objects. Identify the message by its build and content,
  // so dismissal survives refreshes but never hides a new attempt or problem.
  const pdfIssueKey = () =>
    JSON.stringify([projects.project()?.id, latex.state()?.current?.id, issue()]);
  const visiblePdfIssue = () => (dismissedPdfIssue() === pdfIssueKey() ? null : issue());
  const fixPdf = () => {
    if (agent.busy() || agent.submitting() || agent.state()?.running) return;
    prepareScientificRequest(
      'Fix the PDF creation problem in this paper. Inspect the current Loom diagnostics and relevant source files, make the necessary changes while preserving unrelated writing, then build the PDF and verify the result. If setup or permissions prevent a fix, explain the specific blocker.',
      'Repair request prepared. Review and send it; Loom includes the latest PDF diagnostics automatically.',
    );
  };
  const fixPdfBusy = () => agent.busy() || agent.submitting() || !!agent.state()?.running;
  const showPdf = () => update({ pdfOpen: true, mode: narrow() ? 'pdf' : 'split' });
  createAgentChangePreview({
    agent: agent.state,
    project: projects.project,
    latex,
    openPdf: showPdf,
    report: setNotice,
  });
  async function createPdf(checkSetup = true) {
    showPdf();
    if (
      chooseMain() ||
      !projects.project()?.rootId ||
      (checkSetup && issue()?.action === 'setup')
    ) {
      setDialog('build');
      return;
    }
    setDialog(null);
    await latex.compile();
  }
  async function openProject(choice: ProjectChoice, makePdf = false) {
    const previousMain = projects
      .project()
      ?.files.find((file) => file.id === projects.project()?.rootId)
      ?.path.split('/')
      .pop();
    const opened = await projects.choose(choice);
    if (!opened) return;
    const newMain = opened.files.find((file) => file.id === opened.rootId)?.path;
    const conflictingMain = choice === 'main-folder' && newMain !== previousMain;
    setChooseMain(conflictingMain);
    setDialog(null);
    setExample(false);
    setSampleHint(choice === 'sample');
    if (choice === 'sample') {
      const introduction = opened.files.find((file) => file.path === 'sections/introduction.tex');
      if (introduction) await projects.select(introduction.id);
    }
    if (makePdf) showPdf();
    else if (!projects.storedLayout()) update({ pdfOpen: true, mode: 'split' });
    navigateLibrary(false);
    if (makePdf) {
      if (!opened.rootId || conflictingMain) setDialog('build');
      else await latex.compile();
    }
  }
  function recoverPdf() {
    const problem = issue();
    if (!problem) return;
    if (problem.action === 'folder') void openProject('main-folder', true);
    else if (problem.action === 'main' || problem.action === 'setup') setDialog('build');
    else if (problem.location) {
      void latex.locate(problem.location);
      if (narrow()) focusMode('source');
    } else if (problem.action === 'source') setDialog('files');
    else void createPdf();
  }
  const resize = (which: 'sidebar' | 'pdf', delta: number) => {
    const value = Math.max(
      which === 'sidebar' ? 18 : 22,
      Math.min(which === 'sidebar' ? 38 : 45, layout()[which] + delta),
    );
    if (value + layout()[which === 'sidebar' ? 'pdf' : 'sidebar'] <= 75) update({ [which]: value });
  };
  const startDrag = (event: PointerEvent, which: 'sidebar' | 'pdf') => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragCleanup?.();
    const target = event.currentTarget as HTMLElement;
    target.focus();
    target.setPointerCapture(event.pointerId);
    let last = event.clientX;
    const move = (e: PointerEvent) => {
      resize(which, ((e.clientX - last) / shell.clientWidth) * 100 * (which === 'pdf' ? -1 : 1));
      last = e.clientX;
    };
    const end = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('lostpointercapture', end);
      document.body.classList.remove('resizing');
      dragCleanup = undefined;
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('lostpointercapture', end);
    document.body.classList.add('resizing');
    dragCleanup = end;
  };
  const separator = (which: 'sidebar' | 'pdf') => (
    <div
      class="panel-separator"
      role="separator"
      aria-label={which === 'sidebar' ? 'Sidebar width' : 'PDF width'}
      aria-orientation="vertical"
      aria-valuemin={which === 'sidebar' ? 18 : 22}
      aria-valuemax={which === 'sidebar' ? 38 : 45}
      aria-valuenow={Math.round(layout()[which])}
      tabIndex={0}
      onPointerDown={(e) => startDrag(e, which)}
      onDblClick={() => update({ [which]: defaultLayout[which] })}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          resize(which, (e.key === 'ArrowRight' ? 1 : -1) * (which === 'pdf' ? -1 : 1));
        }
        if (e.key === 'Home') {
          e.preventDefault();
          update({ [which]: defaultLayout[which] });
        }
      }}
    />
  );
  const checkService = async (restart = false) => {
    if (busy()) return;
    setBusy(true);
    setServiceError('');
    try {
      if (!window.loom) {
        setService({ state: 'unavailable', pid: null, version: '0.1.0' });
        setServiceError(
          'Desktop service is unavailable in the browser preview. Open the Electron app with npm run dev.',
        );
        return;
      }
      const result = await (restart ? window.loom.restartService() : window.loom.getStatus());
      if (result.ok) setService(result.value);
      else {
        setService({ state: 'unavailable', pid: null, version: '0.1.0' });
        setServiceError(result.error.message);
      }
    } catch {
      setService({ state: 'unavailable', pid: null, version: '0.1.0' });
      setServiceError('Could not reach the desktop service. Retry the connection.');
    } finally {
      setBusy(false);
    }
  };
  let restoredProject = '';
  createEffect(() => {
    const project = projects.project();
    if (project && restoredProject !== project.id) {
      restoredProject = project.id;
      setExample(false);
      const saved = untrack(projects.storedLayout);
      if (saved) setLayout(saved);
      else projects.setStoredLayout(untrack(layout));
    }
  });
  createEffect(() => {
    const value = layout();
    if (untrack(projects.project)) projects.setStoredLayout(value);
  });
  createEffect(() => {
    if (!saveLayout(layoutStorage, layout()))
      setNotice(
        'Layout could not be saved. This session still works; allow local storage to retain it.',
      );
  });
  onMount(() => {
    void checkService();
    const unsubscribe = window.loom?.onServiceEvent((event) => {
      setService(event.status);
      setServiceError(event.error?.message ?? '');
    });
    const handleResize = () => setNarrow(window.innerWidth < 1100);
    const shortcuts = (e: KeyboardEvent) => {
      if (e.isComposing || dialog() || libraryOpen()) return;
      if ((e.ctrlKey || e.metaKey) && e.altKey) {
        if (['1', '2', '3', 'b'].includes(e.key.toLowerCase())) e.preventDefault();
        if (e.key === '1') focusMode('source');
        if (e.key === '2') focusMode('pdf');
        if (e.key === '3') focusMode('split');
        if (e.key.toLowerCase() === 'b') update({ sidebarOpen: !layout().sidebarOpen });
      }
      if (e.key === 'F6') {
        e.preventDefault();
        const regions = [...document.querySelectorAll<HTMLElement>('[data-focus-region]')].filter(
          (el) => el.getClientRects().length,
        );
        const current = regions.findIndex(
          (el) => el === document.activeElement || el.contains(document.activeElement),
        );
        regions[(current + (e.shiftKey ? regions.length - 1 : 1)) % regions.length]?.focus();
      }
    };
    window.addEventListener('resize', handleResize);
    window.addEventListener('keydown', shortcuts);
    onCleanup(() => {
      unsubscribe?.();
      dragCleanup?.();
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('keydown', shortcuts);
    });
  });
  return (
    <div class="app-shell" classList={{ 'library-visible': libraryOpen() }} ref={shell}>
      <Show when={libraryOpen()}>
        <ProjectManager
          pending={projects.pending()}
          error={projects.error()}
          current={projects.project()?.name}
          onContinue={() => navigateLibrary(false)}
          onCloseProject={async () => {
            if (!(await projects.closeProject()))
              throw new Error(
                'The project could not be closed. Save changes and stop active work.',
              );
          }}
          onChoose={(choice) => void openProject(choice)}
          onOpen={async (projectId) => {
            const opened = await projects.choose({ projectId });
            if (opened) navigateLibrary(false);
          }}
          onAppearance={() => setAppearanceOpen(true)}
          onMore={() => setDialog('projects')}
          onSettings={() => setDialog('settings')}
          onService={() => setDialog('service')}
          serviceLabel={
            service().state === 'ready'
              ? 'Local service ready'
              : service().state === 'starting'
                ? 'Local service starting'
                : 'Local service unavailable'
          }
        />
      </Show>
      <a
        class="skip-link"
        href="#source"
        onClick={(event) => {
          event.preventDefault();
          focusMode('source');
        }}
      >
        Skip to source
      </a>
      <header class="compact-bar">
        <BackToProjects />
        <nav aria-label="Workspace views">
          <button aria-pressed={effectiveMode() === 'source'} onClick={() => focusMode('source')}>
            Source
          </button>
          <button aria-pressed={effectiveMode() === 'pdf'} onClick={() => focusMode('pdf')}>
            PDF
          </button>
          <button
            aria-pressed={effectiveMode() === 'split'}
            disabled={narrow()}
            title={
              narrow() ? 'Split view needs a window at least 1100 pixels wide' : 'Show all panels'
            }
            onClick={() => focusMode('split')}
          >
            Split
          </button>
        </nav>
        <IconButton
          label="Workspace settings"
          icon="settings"
          onClick={() => setDialog('settings')}
        />
        <IconButton label="Appearance" icon="appearance" onClick={() => setAppearanceOpen(true)} />
      </header>
      <div class="workspace-grid" style={{ 'grid-template-columns': columns() }}>
        <Show when={sidebarVisible()}>
          <aside class="sidebar" aria-label="Project sidebar" tabIndex={-1} data-focus-region>
            <div class="sidebar-brand">
              <div class="wordmark">
                <LoomLogo />
              </div>
              <IconButton
                label="Collapse sidebar"
                icon="panel"
                onClick={() => update({ sidebarOpen: false })}
              />
            </div>
            <BackToProjects />
            <button
              class="project-selector"
              title="Your projects"
              onClick={() => void showLibrary()}
            >
              <span>
                {projects.project()?.name ?? (example() ? 'Example project' : 'No project open')}
              </span>
              <Icon name="down" />
            </button>
            <Show when={!projects.project()}>
              <div class="file-toolbar">
                <div class="tab-buttons" role="group" aria-label="Sidebar content">
                  <button
                    aria-pressed={layout().tab === 'files'}
                    classList={{ selected: layout().tab === 'files' }}
                    onClick={() => update({ tab: 'files' })}
                  >
                    <Icon name="folder" size={15} />
                    Files
                  </button>
                  <button
                    aria-pressed={layout().tab === 'chats'}
                    classList={{ selected: layout().tab === 'chats' }}
                    onClick={() => update({ tab: 'chats' })}
                  >
                    <Icon name="chat" size={15} />
                    Chats
                  </button>
                </div>
                <IconButton
                  label="Search example files"
                  icon="search"
                  active={searchOpen()}
                  onClick={() => {
                    setSearchOpen(!searchOpen());
                    if (searchOpen()) requestAnimationFrame(() => search?.focus());
                    else setQuery('');
                  }}
                />
                <IconButton
                  label={
                    layout().tab === 'files'
                      ? 'Open or create a project'
                      : 'New chat — availability'
                  }
                  icon="plus"
                  onClick={() => {
                    if (layout().tab === 'files') setDialog('projects');
                    else
                      showUnavailable(
                        'Agent conversations',
                        'Open a paper folder, then connect OpenCode or Codex to start a conversation.',
                      );
                  }}
                />
              </div>
              <Show when={searchOpen()}>
                <div class="search-field">
                  <Icon name="search" />
                  <input
                    ref={search}
                    aria-label="Search example files"
                    placeholder="Search example files…"
                    value={query()}
                    onInput={(e) => setQuery(e.currentTarget.value)}
                  />
                  <Show when={query()}>
                    <IconButton
                      label="Clear file search"
                      icon="close"
                      onClick={() => {
                        setQuery('');
                        search.focus();
                      }}
                    />
                  </Show>
                </div>
              </Show>
              <div class="file-list" aria-live="polite">
                <Show
                  when={layout().tab === 'files'}
                  fallback={
                    <div class="sidebar-empty">
                      <Icon name="chat" />
                      <p>No conversations yet</p>
                      <span>Open a paper folder to start a conversation.</span>
                    </div>
                  }
                >
                  <Show
                    when={example()}
                    fallback={
                      <div class="sidebar-empty">
                        <Icon name="folder" />
                        <p>Your project starts here</p>
                        <span>Open or create a project to begin.</span>
                        <button class="text-button" onClick={showExample}>
                          View workspace example
                        </button>
                      </div>
                    }
                  >
                    <Show
                      when={'main.tex'.includes(query().toLowerCase())}
                      fallback={
                        <div class="sidebar-empty">
                          <p>No matching example files</p>
                          <button
                            class="text-button"
                            onClick={() => {
                              setQuery('');
                              search?.focus();
                            }}
                          >
                            Clear search
                          </button>
                        </div>
                      }
                    >
                      <button
                        class="file-row selected"
                        onClick={() => {
                          focusMode('split');
                          source?.focus();
                        }}
                      >
                        <Icon name="file" />
                        <span>main.tex</span>
                        <span class="file-badge">example</span>
                      </button>
                    </Show>
                  </Show>
                </Show>
              </div>
            </Show>
            <Show when={projects.project()}>
              <ProjectPanel
                latex={latex}
                workspace={projects}
                chats={<AgentChats agent={agent} onConnect={agentConnect} onNewChat={newChat} />}
                onNewChat={newChat}
                tab={layout().tab}
                onTabChange={(tab) => update({ tab })}
                onSettings={() => setDialog('projects')}
              />
            </Show>
            <Show when={!projects.project()}>
              <section class="outline">
                <button
                  class="outline-heading"
                  aria-expanded={layout().outlineOpen}
                  onClick={() => update({ outlineOpen: !layout().outlineOpen })}
                >
                  <span classList={{ rotated: !layout().outlineOpen }}>
                    <Icon name="down" size={16} />
                  </span>
                  Outline
                </button>
                <Show when={layout().outlineOpen}>
                  <Show
                    when={example()}
                    fallback={<p class="outline-empty">Sections will appear here.</p>}
                  >
                    <button
                      class="outline-item"
                      onClick={() => {
                        focusMode('source');
                        requestAnimationFrame(() =>
                          document.getElementById('line-19')?.scrollIntoView({ block: 'center' }),
                        );
                      }}
                    >
                      Introduction
                    </button>
                  </Show>
                </Show>
              </section>
            </Show>
            <footer class="sidebar-footer">
              <IconButton
                label="Workspace settings"
                icon="settings"
                onClick={() => setDialog('settings')}
              />
              <IconButton
                label="Appearance"
                icon="appearance"
                onClick={() => setAppearanceOpen(true)}
              />
            </footer>
          </aside>
          {separator('sidebar')}
        </Show>
        <Show when={sourceVisible()}>
          <main
            class="source-column"
            id="source"
            aria-label="Source workspace"
            tabIndex={-1}
            data-focus-region
            ref={source}
          >
            <div class="source-toolbar">
              <Show when={!sidebarVisible()}>
                <IconButton
                  label="Restore sidebar"
                  icon="panel"
                  onClick={() => {
                    update({ sidebarOpen: true, mode: 'split' });
                    if (narrow()) setDialog('settings');
                  }}
                />
              </Show>
              <Show
                when={projects.project()}
                fallback={
                  <span class="source-tab">
                    <Icon name="file" />
                    <span>{example() ? 'main.tex' : 'Workspace'}</span>
                  </span>
                }
              >
                <div class="document-tabs" role="group" aria-label="Open files">
                  <For
                    each={projects
                      .tabs()
                      .filter((id) =>
                        projects.project()?.files.some((file) => file.id === id && !file.deleted),
                      )}
                  >
                    {(id) => {
                      const file = () => projects.project()?.files.find((file) => file.id === id);
                      return (
                        <button
                          class="document-tab"
                          classList={{ 'source-tab': projects.active() === id }}
                          aria-label={file()?.path}
                          title={file()?.path}
                          aria-pressed={projects.active() === id}
                          onClick={() => void projects.select(id)}
                        >
                          <Icon name="file" size={15} />
                          <span>{file()?.path.split('/').pop()}</span>
                        </button>
                      );
                    }}
                  </For>
                </div>
                <div class="editor-actions">
                  <IconButton label="Save" icon="save" onClick={() => void projects.flush()} />
                  <IconButton
                    label="Find / replace"
                    icon="search"
                    onClick={() =>
                      document
                        .querySelector('.cm-editor')
                        ?.dispatchEvent(new CustomEvent('loom:find'))
                    }
                  />
                  <IconButton label="Project" icon="folder" onClick={() => setDialog('files')} />
                </div>
              </Show>
              <button
                ref={previewToggle}
                class="icon-button preview-toggle"
                aria-label={pdfVisible() ? 'Hide PDF preview' : 'Show PDF preview'}
                title={pdfVisible() ? 'Hide PDF preview' : 'Show PDF preview'}
                aria-pressed={pdfVisible()}
                aria-controls={pdfVisible() ? 'pdf-preview' : undefined}
                onClick={togglePreview}
              >
                <Icon name="preview" />
              </button>
              <Show when={projects.project()}>
                <button
                  class="icon-button compile-source"
                  aria-label={
                    latex.running()
                      ? 'Stop'
                      : latex.state()?.successful
                        ? 'Update PDF'
                        : 'Create PDF'
                  }
                  title={latex.running() ? 'Stop build' : 'Build PDF'}
                  disabled={latex.busy()}
                  onClick={() => (latex.running() ? void latex.cancel() : void createPdf())}
                >
                  <Icon name={latex.running() ? 'stop' : 'build'} />
                </button>
              </Show>
              <Show when={projects.project()}>
                <IconButton
                  label="References"
                  icon="bookOpen"
                  onClick={() => setReferencesOpen(true)}
                />
              </Show>
              <IconButton
                label="Open Git repository"
                icon="gitBranch"
                disabled={!projects.project() || example()}
                onClick={() => setGitOpen(true)}
              />
              <ActionMenu
                label="More workspace actions"
                actions={[
                  { label: 'Scientific tools', icon: 'science', run: () => setDialog('tools') },
                  { label: 'Projects', icon: 'folder', run: () => void showLibrary() },
                  {
                    label: 'Workspace settings',
                    icon: 'settings',
                    run: () => setDialog('settings'),
                  },
                ]}
              />
            </div>
            <Show when={projects.error()}>
              <div role="alert" class="project-error">
                {projects.error()}
                <button onClick={() => void projects.flush()}>Retry save</button>
              </div>
            </Show>
            <Show when={projects.file()?.conflict}>
              <section class="conflict-panel" aria-label="File conflict">
                <h3>External changes need review</h3>
                <p>Your text and the disk version are preserved. Choose which version to keep.</p>
                <details>
                  <summary>Compare baseline and disk</summary>
                  <h4>Last synchronized</h4>
                  <pre>{projects.file()?.baseline ?? '(missing)'}</pre>
                  <h4>Current disk</h4>
                  <pre>{projects.file()?.disk ?? '(deleted or binary)'}</pre>
                </details>
                <button
                  onClick={() =>
                    void projects.command({
                      type: 'resolve',
                      fileId: projects.active(),
                      choice: 'local',
                      disk: projects.file()!.disk,
                      diskRevision: projects.file()!.diskRevision,
                    })
                  }
                >
                  Keep local text
                </button>
                <button
                  onClick={() =>
                    void projects.command({
                      type: 'resolve',
                      fileId: projects.active(),
                      choice: 'disk',
                      disk: projects.file()!.disk,
                      diskRevision: projects.file()!.diskRevision,
                    })
                  }
                >
                  Use disk version
                </button>
              </section>
            </Show>
            <Show when={latex.error()}>
              <div class="project-error" role="alert">
                {latex.error()}
                <button onClick={() => setDialog('build')}>PDF help</button>
              </div>
            </Show>
            <Show when={sampleHint()}>
              <div class="sample-writing-hint" role="status">
                <span>
                  <strong>Try a small change</strong> Edit a sentence below, then choose Update PDF
                  to see it on the page.
                </span>
                <button class="text-button" onClick={() => setSampleHint(false)}>
                  Got it
                </button>
              </div>
            </Show>
            <div class="source-content">
              <Show when={reviewChange()}>
                {(change) => (
                  <AgentDiff
                    change={change()}
                    onClose={closeReview}
                    onKeep={() => void keepReview()}
                    onUndo={() => setUndoChanges([reviewSelection()!])}
                    disabled={agent.busy() || !!agent.state()?.running}
                  />
                )}
              </Show>
              <div class="source-editing" hidden={!!reviewChange()}>
                <Show
                  when={projects.project()}
                  fallback={
                    <>
                      <Show
                        when={example()}
                        fallback={
                          <EmptyState icon="file" title="A place for your next paper">
                            <p>Your source, assistant, and PDF, together.</p>
                            <p>Open your paper’s folder, or try an editable sample.</p>
                            <button class="primary-button" onClick={() => setDialog('projects')}>
                              Open or create project
                            </button>
                            <button
                              class="secondary-button"
                              disabled={projects.pending()}
                              onClick={() => void openProject('sample', true)}
                            >
                              {projects.pending() ? 'Opening sample…' : 'Try a sample paper'}
                            </button>
                          </EmptyState>
                        }
                      >
                        <div
                          class="code-view"
                          role="region"
                          aria-label="Read-only LaTeX example"
                          tabIndex={0}
                        >
                          <For each={exampleSource.split('\n')}>
                            {(line, i) => (
                              <div class="code-line" id={`line-${i()}`}>
                                <span class="line-number" aria-hidden="true">
                                  {i() + 1}
                                </span>
                                <code>
                                  <For each={tokenize(line)}>
                                    {(token) => <span class={token.kind}>{token.text}</span>}
                                  </For>
                                  {line === '' ? ' ' : ''}
                                </code>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                    </>
                  }
                >
                  <Show
                    when={projects.file()}
                    fallback={
                      <EmptyState icon="file" title="Your project is ready">
                        <p>Choose + in Files to create your first source file.</p>
                        <button class="secondary-button" onClick={() => void projects.newFile()}>
                          New file
                        </button>
                      </EmptyState>
                    }
                  >
                    <Show
                      when={projects.file()?.text !== null}
                      fallback={
                        <EmptyState icon="file" title="Project asset">
                          <p>
                            This asset stays in its original format. Text editing is unavailable.
                          </p>
                        </EmptyState>
                      }
                    >
                      <Show when={projects.loading()}>
                        <p role="status">Loading source and recovery state…</p>
                      </Show>
                      <SourceEditor workspace={projects} latex={latex} />
                    </Show>
                  </Show>
                </Show>
              </div>
            </div>
            <div class="editor-statusbar">
              <span class="readonly-label" role="status">
                {projects.project()
                  ? !projects.file()
                    ? 'No file selected'
                    : projects.file()?.text === null
                      ? 'Asset · read only'
                      : projects.saved()
                        ? 'Saved to disk'
                        : projects.file()?.conflict
                          ? 'Conflict · review required'
                          : 'Unsaved · recovery pending'
                  : example()
                    ? 'Example · read only'
                    : 'Open a paper to begin'}
              </span>
              <Show when={projects.file()}>
                <span class="document-path" title={projects.file()?.path}>
                  {projects.file()?.path}
                </span>
              </Show>
            </div>
            <AgentImagePreview agent={agent} />
            <div
              class="agent-workspace-panel"
              classList={{ expanded: agent.open() }}
              style={{ '--chat-height': `${chatHeight()}%` }}
            >
              <Show when={agent.open()}>
                <button
                  class="agent-panel-grip"
                  aria-label="Resize conversation"
                  title="Drag to resize · Arrow keys to adjust"
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                      event.preventDefault();
                      resizeChat(chatHeight() + (event.key === 'ArrowUp' ? 4 : -4));
                    }
                  }}
                  onClick={(event) => {
                    if (event.detail === 0) resizeChat(chatHeight() + 4);
                  }}
                  onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
                  onPointerMove={(event) => {
                    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                    const bounds = event.currentTarget
                      .closest('.source-column')!
                      .getBoundingClientRect();
                    resizeChat(((bounds.bottom - event.clientY) / bounds.height) * 100);
                  }}
                  onPointerUp={(event) =>
                    event.currentTarget.releasePointerCapture(event.pointerId)
                  }
                />
              </Show>
              <AgentConversation agent={agent} onNewChat={newChat} />
              <AgentChanges
                agent={agent}
                onSelect={selectReview}
                onClose={closeReview}
                undo={undoChanges()}
                onUndoChange={setUndoChanges}
              />
              <div class="composer-area">
                <AgentComposer agent={agent} onConnect={agentConnect} onNewChat={newChat} />
              </div>
            </div>
          </main>
        </Show>
        <Show when={sourceVisible() && pdfVisible()}>{separator('pdf')}</Show>
        <Show when={pdfVisible()}>
          <section
            class="pdf-column"
            id="pdf-preview"
            aria-label="PDF preview"
            tabIndex={-1}
            data-focus-region
            ref={pdf}
          >
            <div class="pdf-toolbar">
              <button
                class="build-status"
                onClick={() => (projects.project() ? setDialog('build') : setDialog('projects'))}
              >
                <Icon
                  name={latex.running() ? 'refresh' : latex.state()?.successful ? 'check' : 'info'}
                  size={17}
                />
                <span>
                  {example() ? 'Example preview' : pdfStatus(latex.state(), latex.stale())}
                </span>
                <Icon name="down" size={14} />
              </button>
              <div class="pdf-actions">
                <Show when={latex.running()}>
                  <button class="pdf-stop" onClick={() => void latex.cancel()}>
                    Stop
                  </button>
                </Show>
                <IconButton
                  label={effectiveMode() === 'pdf' ? 'Return to workspace' : 'Focus PDF'}
                  icon="expand"
                  onClick={() => focusMode(effectiveMode() === 'pdf' ? 'split' : 'pdf')}
                />
                <IconButton
                  label="Download PDF"
                  disabled={!latex.state()?.successful}
                  icon="download"
                  onClick={() => void latex.exportPdf()}
                />
                <IconButton label="Hide PDF panel" icon="close" onClick={togglePreview} />
              </div>
            </div>
            <Show when={visiblePdfIssue()}>
              {(problem) => (
                <BuildFeedback
                  issue={problem()}
                  busy={projects.pending() || latex.busy()}
                  retained={!!latex.state()?.successful}
                  onFix={fixPdf}
                  fixBusy={fixPdfBusy()}
                  onAction={recoverPdf}
                  onDetails={() => setDialog('build')}
                  onDismiss={() => {
                    setDismissedPdfIssue(pdfIssueKey());
                    pdf?.querySelector<HTMLButtonElement>('.build-status')?.focus();
                  }}
                />
              )}
            </Show>
            <Show
              when={projects.project() && latex.state()?.successful}
              fallback={
                <>
                  <div class="pdf-scroll">
                    <Show
                      when={example()}
                      fallback={
                        <Show when={!visiblePdfIssue()}>
                          <EmptyState
                            icon="file"
                            title={
                              latex.running() ? 'Your PDF is on its way' : 'See your paper as a PDF'
                            }
                          >
                            <p>
                              {latex.running()
                                ? 'You can keep writing while Loom prepares your paper.'
                                : projects.project()
                                  ? 'Your paper is ready. Create its PDF to read, check and share it.'
                                  : 'Open a paper to see its pages here.'}
                            </p>
                            <Show
                              when={!latex.running()}
                              fallback={
                                <button
                                  class="secondary-button"
                                  onClick={() => void latex.cancel()}
                                >
                                  Stop
                                </button>
                              }
                            >
                              <button
                                class="primary-button"
                                disabled={latex.busy()}
                                onClick={() =>
                                  projects.project() ? void createPdf() : setDialog('projects')
                                }
                              >
                                {projects.project() ? 'Create PDF' : 'Open a paper'}
                              </button>
                            </Show>
                          </EmptyState>
                        </Show>
                      }
                    >
                      <div class="paper" aria-label="Static example paper, not a compiled PDF">
                        <div class="paper-title">Untitled</div>
                        <div class="paper-author">Loom Example</div>
                        <div class="paper-date">Reference manuscript</div>
                        <div class="paper-section">1 &nbsp; Introduction</div>
                        <div class="paper-page">1</div>
                      </div>
                      <p class="paper-disclaimer">Static layout reference · not compiled</p>
                    </Show>
                  </div>
                  <div class="pdf-bottom">
                    <span>{example() ? 'Example page 1 of 1' : 'No PDF loaded'}</span>
                  </div>
                </>
              }
            >
              <div class="pdf-build-freshness" role="status">
                {latex.stale()
                  ? 'Your latest changes are not in this PDF yet'
                  : 'Up to date with your writing'}
                <Show when={latex.stale()}>
                  <button disabled={latex.busy()} onClick={() => void createPdf()}>
                    Update PDF
                  </button>
                </Show>
              </div>
              <PdfViewer
                latex={latex}
                position={pdfPosition()}
                savePosition={setPdfPosition}
                onSource={() => {
                  if (narrow()) focusMode('source');
                }}
              />
            </Show>
          </section>
        </Show>
      </div>
      <footer class="workspace-statusbar">
        <span class="workspace-origin">
          {example()
            ? 'Synthetic example · no files on disk'
            : 'Source stays in your project folder'}
        </span>
        <div class="notice-slot">
          <Show when={notice()}>
            <div
              class="notice"
              role="status"
              onPointerEnter={() => setNoticePaused(true)}
              onPointerLeave={() => setNoticePaused(false)}
              onFocusIn={() => setNoticePaused(true)}
              onFocusOut={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                  setNoticePaused(false);
              }}
            >
              <span>{notice()}</span>
              <IconButton label="Dismiss notification" icon="close" onClick={() => setNotice('')} />
            </div>
          </Show>
        </div>
        <button class="status-button" onClick={() => setDialog('service')}>
          <span class="status-dot" classList={{ ready: service().state === 'ready' }} />
          {service().state === 'ready'
            ? 'Local service ready'
            : service().state === 'starting'
              ? 'Local service starting'
              : 'Local service unavailable'}
        </button>
        <button
          class="status-button"
          disabled={!projects.project() || example()}
          onClick={() => setGitOpen(true)}
          title={example() ? 'Git is unavailable for the synthetic example.' : undefined}
        >
          <Icon name="gitBranch" size={14} />
          {gitStatus()?.repository
            ? `Git · ${gitStatus()?.branch ?? 'detached'}${gitStatus()?.files.length ? ` · ${gitStatus()?.files.length} changed` : ''}`
            : 'Git · check status'}
        </button>
      </footer>
      <AppearanceDialog
        open={appearanceOpen()}
        onClose={() => setAppearanceOpen(false)}
        appearance={appearance}
      />
      <GitWorkspace
        projectId={() => projects.project()?.id}
        open={gitOpen}
        onClose={() => setGitOpen(false)}
        beforeMutation={async () => Boolean(await projects.flushPending())}
        onCloned={async () => {
          await projects.command({ type: 'current' });
        }}
        onStatus={setGitStatus}
        onPreparePublication={() => {
          const starter =
            'Help adapt this manuscript for the journal or conference instructions I will provide. First inspect the instructions and relevant project files, explain proposed changes, and prepare an editable revision. Preserve scientific claims and source assets; do not send or commit changes automatically. I will review all edits and compile the result.';
          const previous = agent.draft().trim();
          agent.setDraft(previous ? `${previous}\n\n${starter}` : starter);
          agent.setOpen(true);
        }}
        onSelectPath={async (path) => {
          const file = projects
            .project()
            ?.files.find((entry) => entry.path === path && !entry.deleted);
          if (file) {
            await projects.select(file.id);
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            document.querySelector<HTMLElement>('.cm-content')?.focus();
          }
        }}
      />
      <AgentConnections
        agent={agent}
        open={connectionsOpen()}
        onClose={() => {
          setConnectionsOpen(false);
          setNewChatProject(null);
        }}
        onConnected={() => {
          if (newChatProject() !== projects.project()?.id) return;
          setNewChatProject(null);
          setConnectionsOpen(false);
          newChat();
        }}
        onOpenProject={() => {
          setNewChatProject(null);
          setConnectionsOpen(false);
          setDialog('projects');
        }}
      />

      <References
        open={referencesOpen()}
        onClose={() => setReferencesOpen(false)}
        projects={projects}
        agent={agent}
        report={setNotice}
      />
      <BuildDialog
        open={dialog() === 'build'}
        onClose={() => setDialog(null)}
        workspace={projects}
        latex={latex}
        forceMainChoice={chooseMain()}
        onMainChosen={() => setChooseMain(false)}
        onCreatePdf={() => void createPdf(false)}
        onOpenPaperFolder={() => void openProject('main-folder', true)}
        onFiles={() => setDialog('files')}
        onFix={fixPdf}
        fixBusy={fixPdfBusy()}
      />
      <Modal
        open={dialog() === 'projects'}
        title="Projects"
        icon="folder"
        onClose={() => setDialog(null)}
      >
        <button class="text-button" onClick={() => void showLibrary()}>
          Your projects
        </button>
        <p class="muted">Open an existing manuscript or start with a clean LaTeX project.</p>
        <Show when={example()}>
          <p>The workspace example is read-only. Open or create a project to edit files.</p>
        </Show>
        <button
          class="sample-paper-entry"
          disabled={projects.pending()}
          onClick={() => void openProject('sample', true)}
        >
          <Icon name="file" size={25} />
          <span>
            <strong>Try a sample paper</strong>
            <small>Edit a sentence and see it in the PDF. No folder selection needed.</small>
          </span>
          <Icon name="chevron" size={18} />
        </button>
        <div class="project-choices">
          <button
            aria-label="Open folder"
            disabled={projects.pending()}
            onClick={() => void openProject('open')}
          >
            <Icon name="folder" size={22} />
            <span>
              Open folder<small>Work with your existing files</small>
            </span>
          </button>
          <button
            aria-label="Create project"
            disabled={projects.pending()}
            onClick={() => void openProject('create')}
          >
            <Icon name="plus" size={22} />
            <span>
              Create project<small>Start with an article template</small>
            </span>
          </button>
          <button
            aria-label="Import folder"
            disabled={projects.pending()}
            onClick={() => void openProject('import-folder')}
          >
            <Icon name="download" size={22} />
            <span>
              Import folder<small>Create a separate copy</small>
            </span>
          </button>
          <button
            aria-label="Import ZIP"
            disabled={projects.pending()}
            onClick={() => void openProject('import-zip')}
          >
            <Icon name="file" size={22} />
            <span>
              Import ZIP<small>Unpack into a new folder</small>
            </span>
          </button>
        </div>
        <div class="project-clone">
          <label class="project-clone-field">
            Clone a Git repository
            <input
              aria-label="Repository URL to clone"
              value={cloneUrl()}
              maxLength={2000}
              placeholder="HTTPS, SSH, or local file URL"
              disabled={cloneBusy()}
              onInput={(event) => setCloneUrl(event.currentTarget.value)}
            />
            <small>Uses your configured Git credential helper or SSH key.</small>
          </label>
          <button
            class="secondary-button"
            aria-label="Clone repository"
            disabled={cloneBusy() || !cloneUrl().trim()}
            onClick={() => void cloneFromChooser()}
          >
            {cloneBusy() ? 'Cloning…' : 'Choose location and clone'}
          </button>
        </div>
        <Show when={cloneError()}>
          <p class="inline-error" role="alert">
            {cloneError()}
          </p>
        </Show>
        <details class="sample-library">
          <summary>More sample papers</summary>
          <div class="project-choices">
            <For
              each={
                [
                  ['sample-biber', 'Paper with references', 'A bibliography using Biber'],
                  ['sample-bibtex', 'Another reference format', 'A bibliography using BibTeX'],
                  [
                    'sample-ambiguous',
                    'Choose between two papers',
                    'Practice choosing a main document',
                  ],
                  ['sample-broken', 'Practice fixing an error', 'See a source-linked explanation'],
                  ['sample-missing-package', 'Missing package example', 'See setup guidance'],
                ] as const
              }
            >
              {([choice, title, detail]) => (
                <button
                  disabled={projects.pending()}
                  onClick={() => void openProject(choice, true)}
                >
                  <Icon name="file" size={22} />
                  <span>
                    {title}
                    <small>{detail}</small>
                  </span>
                </button>
              )}
            </For>
          </div>
          <p class="muted">
            Each sample is your own editable copy. Reopening it keeps your changes.
          </p>
        </details>
        <div class="project-picker-status" role="status">
          {projects.pending()
            ? 'Waiting for project selection…'
            : 'Source and assets stay in ordinary folders.'}
        </div>
        <Show when={projects.error()}>
          <p class="inline-error" role="alert">
            {projects.error()}
          </p>
        </Show>
        <Show when={projects.project()}>
          <div class="project-summary">
            <Icon name="folder" size={21} />
            <div>
              <strong>{projects.project()?.name}</strong>
              <p class="project-root">
                Main document:{' '}
                {projects.project()?.files.find((file) => file.id === projects.project()?.rootId)
                  ?.path ?? 'Choose a main document in PDF settings'}
              </p>
            </div>
            <span>{projects.project()?.files.filter((file) => !file.deleted).length} files</span>
          </div>
          <details class="editor-preferences">
            <summary>Editor preferences</summary>
            <label class="range-row">
              Font size{' '}
              <input
                aria-label="Editor font size"
                type="range"
                min="11"
                max="24"
                value={projects.font()}
                onInput={(event) => projects.setFont(Number(event.currentTarget.value))}
              />
              <output>{projects.font()}px</output>
            </label>
            <label class="check-row">
              <input
                type="checkbox"
                checked={projects.wrap()}
                onChange={(event) => projects.setWrap(event.currentTarget.checked)}
              />
              Wrap source lines
            </label>
          </details>
        </Show>
      </Modal>
      <Modal
        open={dialog() === 'files'}
        title="Project files"
        icon="folder"
        onClose={() => setDialog(null)}
      >
        <div class="navigator-heading">
          <span>{projects.project()?.name}</span>
          <button class="text-button" onClick={() => setDialog('projects')}>
            Project settings
          </button>
        </div>
        <Show when={dialog() === 'files' && projects.project()}>
          <div class="file-navigation">
            <ProjectPanel
              latex={latex}
              workspace={projects}
              chats={
                <AgentChats
                  agent={agent}
                  onNewChat={() => {
                    setDialog(null);
                    newChat();
                  }}
                  onConnect={() => {
                    setDialog(null);
                    agentConnect();
                  }}
                  onSelect={() => setDialog(null)}
                />
              }
              onNewChat={() => {
                setDialog(null);
                newChat();
              }}
              onNavigate={() => setDialog(null)}
              onSettings={() => setDialog('projects')}
            />
          </div>
        </Show>
      </Modal>
      <Modal
        title={
          dialog() === 'tools'
            ? 'Workspace tools'
            : dialog() === 'settings'
              ? 'Workspace settings'
              : dialog() === 'service'
                ? 'Desktop service'
                : availability().title
        }
        open={
          dialog() !== null &&
          dialog() !== 'projects' &&
          dialog() !== 'files' &&
          dialog() !== 'build'
        }
        onClose={() => setDialog(null)}
      >
        <Show when={dialog() === 'availability'}>
          <p>{availability().detail}</p>
          <button class="primary-button" onClick={() => setDialog(null)}>
            Back to workspace
          </button>
        </Show>
        <Show when={dialog() === 'tools' && projects.project()}>
          <section class="dialog-section">
            <h3>Research</h3>
            <p>Search project references, arXiv and your local Zotero library.</p>
            <button
              class="secondary-button"
              onClick={() => {
                setDialog(null);
                setReferencesOpen(true);
              }}
            >
              References
            </button>
          </section>
        </Show>
        <Show when={dialog() === 'tools' && projects.project()}>
          <section class="dialog-section scientific-tools">
            <h3>Scientific content</h3>
            <p>
              Prepare a request for the agent. Review and edit it before sending; selected source
              text is attached when available unless a passage is already attached.
            </p>
            <div class="button-row">
              <button
                class="secondary-button"
                onClick={() =>
                  prepareScientificRequest(
                    'Convert the attached image into editable LaTeX, or TikZ for a suitable diagram. Identify uncertain marks or interpretations and ask me to clarify before inserting them. Ask where to insert it if I have not specified a location. Preserve the original image and existing assets; use project-relative paths. Explain any required packages and labels. A successful build does not establish scientific correctness.',
                    agent.attachments().some((path) => imageMime(path))
                      ? 'Request prepared. Review the draft and attached image before sending.'
                      : 'Request prepared. Attach an image and review the draft before sending.',
                  )
                }
              >
                Convert image
              </button>
              <button
                class="secondary-button"
                onClick={() =>
                  prepareScientificRequest(
                    'Help revise the equation or notation in manuscript context. Ask me for the old and new notation and the intended scope if I have not specified them. Preserve unrelated writing and make changes inspectable.',
                    'Notation request added to the assistant draft. Review it before sending.',
                  )
                }
              >
                Revise notation
              </button>
              <button
                class="secondary-button"
                onClick={() =>
                  prepareScientificRequest(
                    'Help create or revise the requested table or figure, caption and label in editable LaTeX. Ask for missing details rather than inventing data. Preserve existing assets and use project-relative paths.',
                    'Table or figure request added to the assistant draft. Review it before sending.',
                  )
                }
              >
                Table or figure
              </button>
            </div>
          </section>
        </Show>
        <Show when={dialog() === 'tools' && projects.project()}>
          <div class="settings-section">
            <h3>LaTeX</h3>
            <div class="button-row">
              <button class="secondary-button" onClick={() => setDialog('build')}>
                PDF settings
              </button>
              <button
                class="secondary-button"
                onClick={() => {
                  setDialog(null);
                  void latex.forward();
                  if (narrow()) focusMode('pdf');
                  else update({ pdfOpen: true });
                }}
              >
                Show in PDF
              </button>
              <button
                class="secondary-button"
                onClick={() => {
                  setDialog(null);
                  requestAnimationFrame(() =>
                    document
                      .querySelector('.cm-editor')
                      ?.dispatchEvent(new CustomEvent('loom:definition')),
                  );
                }}
              >
                Go to definition · F12
              </button>
              <button
                class="secondary-button"
                onClick={() => {
                  setDialog(null);
                  requestAnimationFrame(() =>
                    document
                      .querySelector('.cm-editor')
                      ?.dispatchEvent(new CustomEvent('loom:complete')),
                  );
                }}
              >
                Complete at cursor · Ctrl Space
              </button>
            </div>
            <p class="muted">{latex.languageStatus()}</p>
          </div>
        </Show>
        <Show when={dialog() === 'tools' || dialog() === 'settings'}>
          <section class="dialog-section">
            <h3>Agent</h3>
            <p>Use OpenCode or Codex with this paper.</p>
            <button
              class="secondary-button"
              onClick={() => {
                setDialog(null);
                agentConnect();
              }}
            >
              Manage connections…
            </button>
            <button
              class="text-button"
              onClick={() => {
                setDialog(null);
                openReview();
              }}
              disabled={!pendingChanges(agent).length}
            >
              Merge Changes
            </button>
          </section>
          <div class="settings-section">
            <h3>View</h3>
            <div class="view-buttons">
              <button
                onClick={() => {
                  focusMode('source');
                  setDialog(null);
                }}
              >
                Source <kbd>Ctrl Alt 1</kbd>
              </button>
              <button
                onClick={() => {
                  focusMode('pdf');
                  setDialog(null);
                }}
              >
                PDF <kbd>Ctrl Alt 2</kbd>
              </button>
              <button
                disabled={narrow()}
                title={narrow() ? 'Widen the window to at least 1100px' : 'Show split view'}
                onClick={() => {
                  focusMode('split');
                  setDialog(null);
                }}
              >
                Split <kbd>Ctrl Alt 3</kbd>
              </button>
            </div>
            <Show when={narrow()}>
              <p class="help-text">
                This window uses a focused view. Widen it to 1100px for all three columns.
              </p>
            </Show>
            <label class="check-row">
              <input
                type="checkbox"
                checked={layout().sidebarOpen}
                onChange={(e) => update({ sidebarOpen: e.currentTarget.checked })}
              />
              Show sidebar in split view
            </label>
            <label class="check-row">
              <input
                type="checkbox"
                checked={layout().pdfOpen}
                onChange={(e) => update({ pdfOpen: e.currentTarget.checked })}
              />
              Show PDF in split view
            </label>
          </div>
          <div class="settings-section">
            <h3>Panel widths</h3>
            <label class="range-row">
              Sidebar{' '}
              <input
                aria-label="Sidebar width"
                type="range"
                min="18"
                max="38"
                value={layout().sidebar}
                onInput={(e) => resize('sidebar', Number(e.currentTarget.value) - layout().sidebar)}
              />
              <output>{Math.round(layout().sidebar)}%</output>
            </label>
            <label class="range-row">
              PDF{' '}
              <input
                aria-label="PDF width"
                type="range"
                min="22"
                max="45"
                value={layout().pdf}
                onInput={(e) => resize('pdf', Number(e.currentTarget.value) - layout().pdf)}
              />
              <output>{Math.round(layout().pdf)}%</output>
            </label>
            <p class="help-text">
              Drag dividers, or focus one and press ← / →. Home restores its reference width.
            </p>
          </div>
          <div class="settings-section">
            <h3>Explore the workspace</h3>
            <div class="button-row">
              <button
                class="secondary-button"
                onClick={() => {
                  showExample();
                  setDialog(null);
                }}
              >
                Load read-only example
              </button>
              <button
                class="secondary-button"
                onClick={() => {
                  setExample(false);
                  setQuery('');
                  setDialog(null);
                  setNotice('Example cleared. No files were changed.');
                }}
              >
                Clear example
              </button>
            </div>
            <button
              class="text-button"
              onClick={() => {
                setLayout({ ...defaultLayout });
                setNotice('Reference layout restored.');
              }}
            >
              Reset layout
            </button>
          </div>
          <div class="settings-section">
            <h3>Keyboard</h3>
            <p class="help-text">
              F6 / Shift F6: move between panels.
              <br />
              Ctrl Alt B: toggle sidebar. Tab: move between controls.
              <br />
              Escape: close dialogs. Use ⌘ in place of Ctrl on macOS.
            </p>
          </div>
          <button class="secondary-button" onClick={() => setDialog('service')}>
            Inspect desktop service
          </button>
        </Show>
        <Show when={dialog() === 'service'}>
          <p>Main → restricted preload → utility process</p>
          <dl class="service-details">
            <dt>Connection</dt>
            <dd aria-live="polite">{busy() ? 'Checking…' : service().state}</dd>
            <dt>Utility process PID</dt>
            <dd>{service().pid ?? 'Unavailable'}</dd>
            <dt>Version</dt>
            <dd>{service().version}</dd>
            <dt>Environment</dt>
            <dd>{window.loom ? 'Electron desktop' : 'Browser preview'}</dd>
          </dl>
          <Show when={serviceError()}>
            <p class="inline-error" role="alert">
              {serviceError()}
            </p>
          </Show>
          <div class="button-row">
            <button class="primary-button" disabled={busy()} onClick={() => void checkService()}>
              {busy() ? 'Checking…' : 'Check connection'}
            </button>
            <button
              class="secondary-button"
              disabled={busy() || !window.loom}
              onClick={() => void checkService(true)}
            >
              Restart service
            </button>
          </div>
          <p class="help-text">
            Restarting interrupts Loom-managed builds and agents. Your saved paper and recovery
            records remain; reconnect an agent to continue.
          </p>
        </Show>
      </Modal>
    </div>
  );
}
