import type { ResearchCommand } from '../../contracts/research';
import { createSignal, onCleanup, onMount } from 'solid-js';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import type {
  ProjectChoice,
  ProjectCommand,
  ProjectResult,
  ProjectSnapshot,
} from '../../contracts/project';
import { layoutSchema, type Layout } from '../workspace/layout';
import { createProjectSearch } from './projectSearch';
export type Caret = { anchor: number; head: number; scroll: number };
export type LiveDocument = {
  doc: Y.Doc;
  persistence: IndexeddbPersistence;
  ready: Promise<void>;
  undo: Y.UndoManager;
  baseline: string | null;
  dirty: boolean;
  initialized: boolean;
};
export function createProjectWorkspace(
  report: (message: string) => void,
  options: { libraryFirst?: boolean } = {},
) {
  const [project, setProject] = createSignal<ProjectSnapshot | null>(null),
    [active, setActive] = createSignal(''),
    [tabs, setTabs] = createSignal<string[]>([]),
    [pending, setPending] = createSignal(false),
    [error, setError] = createSignal(''),
    [storageError, setStorageError] = createSignal(''),
    [version, setVersion] = createSignal(0),
    [editVersion, setEditVersion] = createSignal(0),
    [font, setFont] = createSignal(14),
    [wrap, setWrap] = createSignal(true),
    [storedLayout, setStoredLayout] = createSignal<Layout | null>(null);
  const docs = new Map<string, LiveDocument>(),
    timers = new Map<string, ReturnType<typeof setTimeout>>(),
    carets = new Map<string, Caret>();
  let disposed = false,
    preferencesTimer: ReturnType<typeof setTimeout> | undefined,
    queue: Promise<unknown> = Promise.resolve(),
    loading = new Set<string>();
  const file = () => project()?.files.find((f) => f.id === active()),
    live = (id: string) => docs.get(id);
  function clearDocuments() {
    clearTimeout(preferencesTimer);
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    for (const d of docs.values()) {
      void d.persistence.destroy();
      d.doc.destroy();
    }
    docs.clear();
    loading.clear();
    carets.clear();
    setActive('');
    setTabs([]);
    setFont(14);
    setWrap(true);
    setStoredLayout(null);
  }
  function accept(snapshot: ProjectSnapshot | null, ack?: { id: string; text: string }) {
    if (!snapshot) return;
    if (project()?.id !== snapshot.id) {
      clearDocuments();
      try {
        const p = JSON.parse(snapshot.preferences ?? '{}');
        if (typeof p.font === 'number' && p.font >= 11 && p.font <= 24) setFont(p.font);
        if (typeof p.wrap === 'boolean') setWrap(p.wrap);
        if (Array.isArray(p.tabs))
          setTabs(
            p.tabs.filter(
              (id: unknown) => typeof id === 'string' && snapshot.files.some((f) => f.id === id),
            ),
          );
        if (typeof p.active === 'string') setActive(p.active);
        const layout = layoutSchema.safeParse(p.layout);
        if (layout.success) setStoredLayout(layout.data);
        if (p.carets && typeof p.carets === 'object')
          for (const [id, c] of Object.entries(p.carets)) {
            const v = c as Caret;
            if (
              Number.isSafeInteger(v.anchor) &&
              Number.isSafeInteger(v.head) &&
              v.anchor >= 0 &&
              v.head >= 0 &&
              Number.isFinite(v.scroll)
            )
              carets.set(id, v);
          }
      } catch {
        /* Defaults preserve usability. */
      }
    }
    for (const f of snapshot.files) {
      const d = docs.get(f.id);
      if (!d || !d.initialized || !f.loaded) continue;
      // An acknowledged own write advances the bridge even if typing continued.
      // Keep newer text dirty; do not apply the older document over it.
      if (ack?.id === f.id && !f.conflict && d.doc.getText('source').toString() === ack.text)
        d.dirty = false;
      if (ack?.id === f.id && !f.conflict && f.baseline === ack.text) {
        d.baseline = f.baseline;
        d.dirty = d.doc.getText('source').toString() !== ack.text;
        d.doc.transact(() => d.doc.getMap('bridge').set('baseline', f.baseline), 'service');
      }
      if (!d.dirty) {
        Y.applyUpdate(d.doc, Uint8Array.from(f.update), 'service');
        d.baseline = f.baseline;
        d.doc.transact(() => d.doc.getMap('bridge').set('baseline', f.baseline), 'service');
      }
    }
    setProject(snapshot);
    setVersion((v) => v + 1);
    if (!snapshot.files.some((f) => f.id === active() && !f.deleted)) {
      const first =
        snapshot.files.find((f) => f.id === snapshot.rootId && !f.deleted) ??
        snapshot.files.find((f) => !f.deleted && f.text !== null);
      if (first) void select(first.id);
    } else if (!docs.has(active()) && !loading.has(active())) void select(active());
  }
  function request(
    input: ProjectCommand | (() => ProjectCommand | undefined),
  ): Promise<ProjectResult | undefined> {
    const run = async () => {
      if (disposed) return;
      if (!window.loom) {
        setError('Open the Electron app to work with project files.');
        return;
      }
      const c = typeof input === 'function' ? input() : input;
      if (!c) return;
      const ack = c.type === 'sync' ? { id: c.fileId, text: c.text } : undefined;
      const result = await window.loom.project(c);
      if (disposed) return;
      if (result.ok) {
        setError('');
        accept(result.value, ack);
      } else setError(result.error.message);
      return result;
    };
    const next = queue.then(run);
    queue = next.catch(() => {});
    return next;
  }
  async function flush(id = active()) {
    const d = docs.get(id);
    if (!d) return;
    clearTimeout(timers.get(id));
    timers.delete(id);
    await d.ready;
    if (!d.initialized)
      return {
        ok: false as const,
        error: {
          code: 'RECOVERY_UNAVAILABLE',
          message: 'Recovery storage is unavailable. Reopen Loom to retry.',
          retryable: true,
        },
      };
    return request(() => {
      if (docs.get(id) !== d) return;
      // Capture after earlier saves are acknowledged, not when entering the queue.
      return {
        type: 'sync',
        fileId: id,
        baseline: d.baseline,
        text: d.doc.getText('source').toString(),
        update: Array.from(Y.encodeStateAsUpdate(d.doc)),
      };
    });
  }
  async function flushPending() {
    for (const [id, d] of docs)
      if (d.dirty) {
        const result = await flush(id);
        if (result && !result.ok) return false;
      }
    return true;
  }
  async function command(c: ProjectCommand) {
    if (c.type !== 'sync' && c.type !== 'current' && !(await flushPending())) return;
    return request(c);
  }
  function persistPreferences() {
    if (!project()) return Promise.resolve(undefined);
    return request({
      type: 'preferences',
      value: JSON.stringify({
        active: active(),
        tabs: tabs(),
        font: font(),
        wrap: wrap(),
        layout: storedLayout(),
        carets: Object.fromEntries(carets),
      }),
    });
  }
  function preferences() {
    clearTimeout(preferencesTimer);
    preferencesTimer = setTimeout(() => void persistPreferences(), 300);
  }
  async function select(id: string) {
    const f = project()?.files.find((f) => f.id === id);
    if (!f || f.deleted) return;
    const existing = docs.has(id);
    setActive(id);
    setTabs((old) => (old.includes(id) ? old : [...old, id]));
    if (f.text !== null && !docs.has(id) && !loading.has(id)) {
      loading.add(id);
      const projectId = project()!.id;
      let loaded = f;
      if (!loaded.loaded) {
        const result = await request({ type: 'load', fileId: id });
        if (!result?.ok || !result.value) {
          loading.delete(id);
          return;
        }
        loaded = result.value.files.find((f) => f.id === id)!;
      }
      if (project()?.id !== projectId || disposed) return;
      const doc = new Y.Doc(),
        persistence = new IndexeddbPersistence(`loom:${projectId}:${id}`, doc),
        undo = new Y.UndoManager(doc.getText('source'));
      const d: LiveDocument = {
        doc,
        persistence,
        undo,
        ready: Promise.resolve(),
        baseline: loaded.baseline,
        dirty: false,
        initialized: false,
      };
      docs.set(id, d);
      loading.delete(id);
      let recoveryTimeout: ReturnType<typeof setTimeout>;
      const recovered = Promise.race([
        persistence.whenSynced,
        new Promise<never>((_resolve, reject) => {
          recoveryTimeout = setTimeout(() => reject(new Error('Recovery timeout')), 5000);
        }),
      ]);
      d.ready = recovered
        .then(() => {
          clearTimeout(recoveryTimeout);
          if (disposed || docs.get(id) !== d) return;
          const recovered = doc.getMap('bridge').get('baseline');
          const recoveredText = doc.getText('source').toString();
          if (
            (typeof recovered === 'string' || recovered === null) &&
            recoveredText !== recovered
          ) {
            d.baseline = recovered;
            d.dirty = true;
          } else {
            if (loaded.update.length) Y.applyUpdate(doc, Uint8Array.from(loaded.update), 'service');
            d.baseline = loaded.baseline;
            doc.transact(() => doc.getMap('bridge').set('baseline', loaded.baseline), 'service');
          }
          d.initialized = true;
          doc.on('update', (_update: Uint8Array, origin: unknown) => {
            if (origin === 'service') {
              setVersion((v) => v + 1);
              return;
            }
            d.dirty = true;
            setEditVersion((v) => v + 1);
            setVersion((v) => v + 1);
            clearTimeout(timers.get(id));
            timers.set(
              id,
              setTimeout(() => void flush(id), 350),
            );
          });
          if (persistence.db)
            persistence.db.onerror = () =>
              setStorageError('Local recovery storage failed. Save to disk before closing.');
          setVersion((v) => v + 1);
          void flush(id);
        })
        .catch(() => {
          setStorageError(
            'Local recovery storage is unavailable. Reopen Loom to retry; project files are retained.',
          );
        });
      setVersion((v) => v + 1);
    }
    if (existing) await command({ type: 'load', fileId: id });
    preferences();
  }
  async function newFile(directory?: string) {
    const current = project();
    if (!current || pending()) return;
    if (!window.loom) {
      setError('File dialogs require the Electron desktop app.');
      return;
    }
    setError('');
    setPending(true);
    try {
      if (!(await flushPending())) return;
      await queue;
      const known = new Set(current.files.map((f) => f.id));
      const result = await window.loom.chooseFile({
        projectId: current.id,
        ...(directory ? { directory } : {}),
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      if (!result.value) return;
      setError('');
      accept(result.value);
      const created = result.value.files.find((f) => !known.has(f.id) && !f.deleted);
      if (created) {
        await select(created.id);
        report(`Created ${created.path}.`);
        return created.id;
      }
    } finally {
      setPending(false);
    }
  }
  async function choose(choice: ProjectChoice | { projectId: string }) {
    if (pending()) return;
    if (!window.loom) {
      setError('Project folders require the Electron desktop app.');
      return;
    }
    setPending(true);
    try {
      if (!(await flushPending())) return;
      clearTimeout(preferencesTimer);
      const preferencesResult = await persistPreferences();
      if (project() && !preferencesResult?.ok) return;
      await queue;
      const result =
        typeof choice === 'string'
          ? await window.loom.chooseProject(choice)
          : await window.loom.project({ type: 'reopen', projectId: choice.projectId });
      if (result.ok) {
        accept(result.value);
        if (result.value) {
          setError('');
          report(`Opened ${result.value.name}.`);
          return result.value;
        }
      } else setError(result.error.message);
    } finally {
      setPending(false);
    }
  }
  const saved = () => {
    version();
    const f = file(),
      d = docs.get(active());
    return !!f?.saved && (!d || (!d.dirty && d.doc.getText('source').toString() === d.baseline));
  };
  async function closeProject() {
    const current = project();
    if (pending() || !current) return false;
    setPending(true);
    try {
      if (!(await flushPending())) return false;
      clearTimeout(preferencesTimer);
      if (!(await persistPreferences())?.ok) return false;
      const result = await request({ type: 'close-project', projectId: current.id });
      if (!result?.ok) return false;
      clearDocuments();
      setProject(null);
      setVersion((value) => value + 1);
      report(`Closed ${current.name}.`);
      return true;
    } finally {
      setPending(false);
    }
  }
  async function locate(id: string, offset: number, length = 0) {
    const projectId = project()?.id;
    await select(id);
    await docs.get(id)?.ready;
    if (project()?.id !== projectId || active() !== id) return;
    requestAnimationFrame(() => {
      if (project()?.id !== projectId || active() !== id) return;
      document
        .querySelector('.cm-editor')
        ?.dispatchEvent(new CustomEvent('loom:locate', { detail: { offset, length } }));
    });
  }
  const search = createProjectSearch({ project, command, locate });
  onMount(() => {
    if (!options.libraryFirst) void request({ type: 'current' });
    let refreshing = false;
    const interval = setInterval(async () => {
      if (refreshing || !project() || pending()) return;
      refreshing = true;
      try {
        if (await flushPending()) await request({ type: 'refresh' });
      } finally {
        refreshing = false;
      }
    }, 1000);
    const unsubscribe = window.loom?.onServiceEvent((event) => {
      if (event.status.state === 'ready' && project())
        void (async () => {
          setError('Reconnecting project and recovery state…');
          await request({ type: 'current' });
          for (const id of docs.keys()) await flush(id);
        })();
    });
    let closing = false;
    const close = window.loom?.onCloseRequest(() => {
      if (closing) return;
      closing = true;
      void (async () => {
        try {
          for (const [id, document] of docs) {
            if (!document.dirty) continue;
            const result = await flush(id);
            if (result && !result.ok) return;
          }
          clearTimeout(preferencesTimer);
          const preferencesResult = await persistPreferences();
          if (project() && !preferencesResult?.ok) return;
          await queue;
          if ([...docs.values()].some((d) => d.dirty)) {
            setError('Still saving. Wait for the disk acknowledgment and close again.');
            return;
          }
          await window.loom?.completeClose();
        } finally {
          closing = false;
        }
      })();
    });
    onCleanup(() => {
      clearInterval(interval);
      unsubscribe?.();
      close?.();
    });
  });
  onCleanup(() => {
    disposed = true;
    clearTimeout(preferencesTimer);
    for (const t of timers.values()) clearTimeout(t);
    for (const d of docs.values()) {
      void d.persistence.destroy();
      d.doc.destroy();
    }
  });
  return {
    project,
    active,
    tabs,
    file,
    live,
    version,
    editVersion,
    pending,
    error: () => storageError() || error(),
    loading: () => {
      version();
      return !!file() && file()?.text !== null && !docs.get(active())?.initialized;
    },
    saved,
    font,
    wrap,
    storedLayout,
    setStoredLayout: (v: Layout) => {
      setStoredLayout(v);
      preferences();
    },
    setFont: (v: number) => {
      setFont(v);
      preferences();
    },
    setWrap: (v: boolean) => {
      setWrap(v);
      preferences();
    },
    caret: (id: string) => carets.get(id),
    saveCaret: (id: string, c: Caret) => {
      carets.set(id, c);
      preferences();
    },
    locate,
    select,
    command,
    flush,
    choose,
    closeProject,
    newFile,
    flushPending,
    saveSession: async () => {
      if (pending() || !(await flushPending())) return false;
      clearTimeout(preferencesTimer);
      const result = await persistPreferences();
      await queue;
      return !project() || !!result?.ok;
    },
    research: async (command: ResearchCommand, isCurrent: () => boolean = () => true) => {
      if (!(await flushPending()) || !window.loom) return;
      await queue;
      if (!isCurrent()) return;
      const result = await window.loom.research(command);
      if (result.ok && result.value.snapshot && project()?.id === result.value.snapshot.id)
        accept(result.value.snapshot);
      return result;
    },
    search,
  };
}
export type ProjectWorkspace = ReturnType<typeof createProjectWorkspace>;
