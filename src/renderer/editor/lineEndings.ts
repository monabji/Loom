import { Annotation, EditorSelection } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from '@codemirror/view';
import {
  createAbsolutePositionFromRelativePosition,
  createRelativePositionFromTypeIndex,
  type RelativePosition,
  type Transaction,
  type YTextEvent,
} from 'yjs';
import type { LiveDocument } from './documents';

const normalize = (text: string) => text.replace(/\r\n?/g, '\n');

export function editorOffset(raw: string, offset: number) {
  return raw.includes('\r\n') ? normalize(raw.slice(0, offset)).length : offset;
}

// Each mapper receives offsets in order, so one edit batch only scans the source once.
function toRawOffsets(raw: string) {
  if (!raw.includes('\r\n')) return (offset: number) => offset;
  let logical = 0;
  let index = 0;
  return (offset: number) => {
    while (logical < offset && index < raw.length) {
      if (raw[index] === '\r' && raw[index + 1] === '\n') index++;
      index++;
      logical++;
    }
    return index;
  };
}

export function rawSourceOffset(raw: string, offset: number) {
  return toRawOffsets(raw)(offset);
}

export function lineEndingBinding(document: LiveDocument) {
  const source = document.doc.getText('source');
  const incoming = Annotation.define<boolean>();
  const origin = {};
  const preferred = source.toString().match(/\r\n?|\n/)?.[0] ?? '\n';
  const plugin = ViewPlugin.fromClass(
    class {
      private selection?: {
        transaction: Transaction;
        anchor: RelativePosition;
        head: RelativePosition;
      };
      private captureSelection = (transaction: Transaction) => {
        if (transaction.origin === origin) return;
        const raw = source.toString();
        const { anchor, head } = this.view.state.selection.main;
        this.selection = {
          transaction,
          anchor: createRelativePositionFromTypeIndex(source, rawSourceOffset(raw, anchor)),
          head: createRelativePositionFromTypeIndex(source, rawSourceOffset(raw, head)),
        };
      };
      private observe = (_event: YTextEvent, transaction: Transaction) => {
        if (transaction.origin === origin) return;
        const before = this.view.state.doc.toString();
        const raw = source.toString();
        const after = normalize(raw);
        if (before === after) return;
        let from = 0;
        let to = before.length;
        let end = after.length;
        while (from < to && from < end && before[from] === after[from]) from++;
        while (to > from && end > from && before[to - 1] === after[end - 1]) {
          to--;
          end--;
        }
        const saved = this.selection?.transaction === transaction ? this.selection : undefined;
        const anchor =
          saved && createAbsolutePositionFromRelativePosition(saved.anchor, document.doc);
        const head = saved && createAbsolutePositionFromRelativePosition(saved.head, document.doc);
        this.view.dispatch({
          changes: { from, to, insert: after.slice(from, end) },
          annotations: incoming.of(true),
          selection:
            anchor?.type === source && head?.type === source
              ? EditorSelection.single(
                  editorOffset(raw, anchor.index),
                  editorOffset(raw, head.index),
                )
              : undefined,
        });
      };
      constructor(private view: EditorView) {
        document.undo.addTrackedOrigin(origin);
        document.doc.on('beforeTransaction', this.captureSelection);
        source.observe(this.observe);
      }
      update(update: ViewUpdate) {
        if (!update.docChanged || update.transactions.some((tr) => tr.annotation(incoming))) return;
        const raw = source.toString();
        const offset = toRawOffsets(raw);
        const separator = raw.match(/\r\n?|\n/)?.[0] ?? preferred;
        let adjustment = 0;
        document.doc.transact(() => {
          update.changes.iterChanges((from, to, _fromB, _toB, insert) => {
            const start = offset(from);
            const removed = offset(to) - start;
            const text = insert.sliceString(0, insert.length, separator);
            if (removed) source.delete(start + adjustment, removed);
            if (text) source.insert(start + adjustment, text);
            adjustment += text.length - removed;
          });
        }, origin);
      }
      destroy() {
        source.unobserve(this.observe);
        document.doc.off('beforeTransaction', this.captureSelection);
        document.undo.removeTrackedOrigin(origin);
      }
    },
  );
  const undo = () => {
    document.undo.undo();
    return true;
  };
  const redo = () => {
    document.undo.redo();
    return true;
  };
  return [
    plugin,
    keymap.of([
      { key: 'Mod-z', run: undo, preventDefault: true },
      { key: 'Mod-y', mac: 'Mod-Shift-z', run: redo, preventDefault: true },
      { key: 'Mod-Shift-z', run: redo, preventDefault: true },
    ]),
    EditorView.domEventHandlers({
      beforeinput(event) {
        if (event.inputType === 'historyUndo') return undo();
        if (event.inputType === 'historyRedo') return redo();
        return false;
      },
    }),
  ];
}
