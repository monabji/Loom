import { languageExtensions } from '../latex/editor';
import type { LatexWorkspace } from '../latex/workspace';
import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { EditorState, EditorSelection, Compartment, Prec, Text } from '@codemirror/state';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import {
  searchKeymap,
  highlightSelectionMatches,
  search,
  openSearchPanel,
} from '@codemirror/search';
import { StreamLanguage, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type { ProjectWorkspace } from './documents';
import { projectSearchHighlights } from './searchHighlights';
import { editorOffset, lineEndingBinding } from './lineEndings';
// Stock CodeMirror colors target light surfaces. Resolve every colored role through Loom's dark tokens.
const sourceHighlight = HighlightStyle.define([
  {
    tag: [
      tags.keyword,
      tags.tagName,
      tags.meta,
      tags.processingInstruction,
      tags.standard(tags.variableName),
    ],
    color: 'var(--syntax-command)',
  },
  { tag: tags.bracket, color: 'var(--syntax-brace)' },
  {
    tag: [tags.atom, tags.number, tags.string, tags.special(tags.variableName)],
    color: 'var(--syntax-option)',
  },
  { tag: tags.comment, color: 'var(--syntax-comment)' },
  { tag: tags.link, color: 'var(--accent-text)' },
  { tag: tags.invalid, color: 'var(--error)' },
]);
export function SourceEditor(props: { workspace: ProjectWorkspace; latex: LatexWorkspace }) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  const [editor, setEditor] = createSignal<EditorView>();
  const wrap = new Compartment();
  const font = new Compartment();
  const projectSearch = new Compartment();
  const document = createMemo(() => {
    props.workspace.version();
    return props.workspace.live(props.workspace.active());
  });
  createEffect(() => {
    const w = props.workspace;
    const d = document();
    if (!d) return;
    const id = w.active();
    let cancelled = false;
    void d.ready.then(() => {
      if (cancelled || !d.initialized) return;
      const caret = w.editorCaret(id);
      const source = d.doc.getText('source');
      const raw = source.toString();
      const text = Text.of(raw.split(/\r\n?|\n/));
      const preserveLineEndings = navigator.platform.startsWith('Win') || raw.includes('\r');
      view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: text,
          selection: EditorSelection.single(
            Math.min(caret?.anchor ?? 0, text.length),
            Math.min(caret?.head ?? 0, text.length),
          ),
          extensions: [
            languageExtensions(w, props.latex, id),
            search({ top: true }),
            projectSearch.of(projectSearchHighlights(w.search.highlightQuery())),
            EditorView.updateListener.of((update) => {
              if (update.selectionSet || update.docChanged) {
                const selection = update.state.selection.main;
                w.saveCaret(id, {
                  anchor: selection.anchor,
                  head: selection.head,
                  scroll: update.view.scrollDOM.scrollTop,
                });
              }
            }),
            lineNumbers(),
            highlightActiveLine(),
            highlightSelectionMatches(),
            StreamLanguage.define(stex),
            syntaxHighlighting(sourceHighlight),
            Prec.highest(
              EditorView.domEventHandlers({
                keydown(event) {
                  if (
                    !event.isComposing &&
                    (event.ctrlKey || event.metaKey) &&
                    !event.altKey &&
                    event.shiftKey &&
                    event.key.toLowerCase() === 'z'
                  ) {
                    event.preventDefault();
                    d.undo.redo();
                    return true;
                  }
                  return false;
                },
              }),
            ),
            keymap.of([
              ...(!preserveLineEndings ? yUndoManagerKeymap : []),
              ...searchKeymap,
              ...defaultKeymap,
              indentWithTab,
              {
                key: 'Mod-s',
                run: () => {
                  void w.flush();
                  return true;
                },
              },
            ]),
            preserveLineEndings
              ? lineEndingBinding(d)
              : yCollab(source, undefined, { undoManager: d.undo }),
            wrap.of(w.wrap() ? EditorView.lineWrapping : []),
            font.of(EditorView.theme({ '&': { fontSize: `${w.font()}px` } })),
            EditorView.theme(
              {
                '&': {
                  height: '100%',
                  backgroundColor: 'var(--surface-editor)',
                  color: 'var(--text-primary)',
                },
                '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-source)' },
                '.cm-content': { caretColor: 'var(--text-primary)' },
                '.cm-gutters': {
                  background: 'var(--surface-editor)',
                  color: 'var(--text-muted)',
                  border: 'none',
                },
                '.cm-activeLine': { background: '#ffffff08' },
                '&.cm-focused': { outline: 'none' },
                '.cm-cursor': { borderLeftColor: 'var(--text-primary)' },
              },
              { dark: true },
            ),
            EditorView.contentAttributes.of({
              'aria-label': 'LaTeX source editor',
              spellcheck: 'false',
            }),
          ],
        }),
      });
      setEditor(view);
      if (caret) view.scrollDOM.scrollTop = caret.scroll;
      view.dom.addEventListener('loom:find', () => openSearchPanel(view!));
      const locate = (event: Event) => {
        const target = (event as CustomEvent<{ offset: number; length: number }>).detail;
        const raw = source.toString();
        const limit = view!.state.doc.length;
        const offset = Math.max(0, Math.min(editorOffset(raw, target.offset), limit));
        const end = Math.max(
          offset,
          Math.min(editorOffset(raw, target.offset + target.length), limit),
        );
        view!.dispatch({
          selection: {
            anchor: offset,
            head: end,
          },
          scrollIntoView: true,
        });
        view!.focus();
      };
      view.dom.addEventListener('loom:locate', locate);
    });
    onCleanup(() => {
      cancelled = true;
      if (view) {
        const selection = view.state.selection.main;
        w.saveCaret(id, {
          anchor: selection.anchor,
          head: selection.head,
          scroll: view.scrollDOM.scrollTop,
        });
      }
      view?.destroy();
      view = undefined;
      setEditor(undefined);
    });
  });
  createEffect(() => {
    const current = editor(),
      query = props.workspace.search.highlightQuery();
    current?.dispatch({ effects: projectSearch.reconfigure(projectSearchHighlights(query)) });
  });
  // Font and wrapping changes are handled by the editor's compartments.
  createEffect(() => {
    const wrapping = props.workspace.wrap(),
      size = props.workspace.font();
    view?.dispatch({
      effects: [
        wrap.reconfigure(wrapping ? EditorView.lineWrapping : []),
        font.reconfigure(EditorView.theme({ '&': { fontSize: `${size}px` } })),
      ],
    });
  });
  return <div class="live-editor" ref={host} />;
}
