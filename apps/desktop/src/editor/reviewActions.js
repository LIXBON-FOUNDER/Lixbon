// reviewActions.js — aceptar o rechazar lo que cambió el agente, por bloque o
// por archivo, desde el editor. Rechazar escribe en disco al momento: el
// archivo ya estaba guardado por el agente y no debe quedar a medias.
import { EditorView } from '@codemirror/view';
import { useChatStore } from '../store/chatStore';
import { useFileViewStore } from '../store/fileViewStore';
import { useReviewStore, pendingChanges, relOf } from '../store/reviewStore';
import { applyHunkToOld, revertHunkInNew } from '../lib/lineDiff';
import { reviewHunks, reviewBaseline } from './agentReview';

function replaceDoc(view, next) {
  const cur = view.state.doc.toString();
  let a = 0;
  while (a < cur.length && a < next.length && cur[a] === next[a]) a++;
  let b = 0;
  while (b < cur.length - a && b < next.length - a && cur[cur.length - 1 - b] === next[next.length - 1 - b]) b++;
  view.dispatch({ changes: { from: a, to: cur.length - b, insert: next.slice(a, next.length - b) } });
}

export function acceptFile(path) {
  const rel = relOf(path);
  if (!rel) return;
  useChatStore.getState().acceptChanges(rel);
  useReviewStore.getState().clearOverride(rel);
}

export function acceptHunk(view, path, index) {
  const h = reviewHunks(view)[index];
  if (!h) return;
  const base = applyHunkToOld(reviewBaseline(view) ?? '', h);
  if (base === view.state.doc.toString()) acceptFile(path);
  else useReviewStore.getState().setOverride(relOf(path), base);
}

export async function rejectHunk(view, path, index) {
  const h = reviewHunks(view)[index];
  if (!h) return;
  const next = revertHunkInNew(view.state.doc.toString(), h);
  replaceDoc(view, next);
  await useFileViewStore.getState().save(path);
  if (next === (reviewBaseline(view) ?? '')) acceptFile(path);
}

export async function rejectFile(view, path) {
  const rel = relOf(path);
  if (!rel) return;
  const override = useReviewStore.getState().overrides[rel];
  if (override !== undefined) {
    replaceDoc(view, override);
    await useFileViewStore.getState().save(path);
    acceptFile(path);
    return;
  }
  const { messages, revertTool } = useChatStore.getState();
  const entry = pendingChanges(messages).get(rel);
  for (const i of [...(entry?.indices || [])].reverse()) await revertTool(i);
  if (entry?.baseline === null) useFileViewStore.getState().clearUnder(path);
  else await useFileViewStore.getState().syncFromDisk();
}

export function jumpHunk(view, dir) {
  const hunks = reviewHunks(view);
  if (!hunks.length) return;
  const doc = view.state.doc;
  const cur = doc.lineAt(view.state.selection.main.head).number - 1;
  const order = dir > 0 ? hunks : [...hunks].reverse();
  const target = order.find((h) => (dir > 0 ? h.newStart > cur : h.newStart < cur)) || order[0];
  const pos = doc.line(Math.min(doc.lines, target.newStart + 1)).from;
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
  view.focus();
}
