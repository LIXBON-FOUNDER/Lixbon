// InlineEdit.jsx — barra de Ctrl+I sobre la selección: instrucción → el
// modelo reescribe el fragmento → aceptar o rechazar el cambio en el editor.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { streamChatCompletion } from '../lib/stream';
import { splitThinking } from '../lib/agentProtocol';
import { getActiveView } from './CodeEditor';
import { inlineTarget, applyInline, acceptInline, rejectInline } from './inlineState';
import { languageLabel } from './languages';
import { SpinRing } from '../components/Ring';
import { LogoMark } from '../components/Logo';
import { IconArrowUp } from '../components/Icons';

const CONTEXT_LINES = 40;

const SYSTEM = 'Eres un editor de código dentro de un IDE. Reescribe SOLO el fragmento marcado según la instrucción. '
  + 'Responde únicamente con el código final del fragmento: sin explicaciones, sin bloques ``` y sin repetir el contexto. '
  + 'Conserva la indentación, el estilo y las convenciones del archivo.';

function cleanResult(raw, original) {
  let out = splitThinking(raw).visible;
  const fenced = out.match(/```[\w-]*\n([\s\S]*?)\n?```/);
  if (fenced) out = fenced[1];
  out = out.replace(/^\n+/, '');
  if (!original.endsWith('\n')) out = out.replace(/\n+$/, '');
  return out;
}

function contextAround(view, from, to) {
  const doc = view.state.doc;
  const a = doc.lineAt(from).number;
  const b = doc.lineAt(to).number;
  const before = doc.sliceString(doc.line(Math.max(1, a - CONTEXT_LINES)).from, doc.lineAt(from).from);
  const after = doc.sliceString(doc.lineAt(to).to, doc.line(Math.min(doc.lines, b + CONTEXT_LINES)).to);
  return { before, after };
}

export function InlineEdit({ path, relPath, onClose }) {
  const view = getActiveView();
  const [target] = useState(() => inlineTarget(view));
  const [prompt, setPrompt] = useState('');
  const [phase, setPhase] = useState('prompt'); // 'prompt' | 'running' | 'review'
  const [error, setError] = useState('');
  const [top, setTop] = useState(0);
  const abortRef = useRef(null);
  const inputRef = useRef(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useLayoutEffect(() => {
    const place = () => {
      const host = view.dom.getBoundingClientRect();
      const pos = phaseRef.current === 'review' ? view.state.selection.main.head : target.from;
      const c = view.coordsAtPos(pos);
      if (!c) return;
      setTop(phaseRef.current === 'review' ? c.bottom - host.top + 6 : Math.max(4, c.top - host.top - 46));
    };
    place();
    view.scrollDOM.addEventListener('scroll', place);
    return () => view.scrollDOM.removeEventListener('scroll', place);
  }, [view, target, phase]);

  useEffect(() => () => {
    abortRef.current?.abort();
    if (phaseRef.current === 'review') acceptInline(view);
  }, [view]);

  const close = (focus = true) => {
    onClose();
    if (focus) view.focus();
  };

  const accept = () => { acceptInline(view); close(); };
  const reject = () => { rejectInline(view); close(); };

  useEffect(() => {
    if (phase !== 'review') return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); reject(); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); accept(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    const instruction = prompt.trim();
    if (!instruction || phase === 'running') return;
    const { serverUrl, apiKey, currentModel, contextWindow } = useAppStore.getState();
    if (!currentModel) { setError('Elige un modelo en el chat primero.'); return; }
    setError('');
    setPhase('running');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const { before, after } = contextAround(view, target.from, target.to);
    const user = [
      `Archivo: ${relPath}`,
      `Lenguaje: ${languageLabel(path)}`,
      '', 'Contexto anterior:', before,
      '', target.text ? '<<<FRAGMENTO' : '<<<INSERTAR AQUÍ (el fragmento está vacío: escribe el código nuevo)',
      target.text, 'FRAGMENTO>>>',
      '', 'Contexto posterior:', after,
      '', `Instrucción: ${instruction}`,
    ].join('\n');
    let raw = '';
    try {
      await streamChatCompletion({
        serverUrl, apiKey, model: currentModel, signal: ctrl.signal, numCtx: contextWindow, noPersist: true,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
        onDelta: (d) => { raw += d; },
      });
      const text = cleanResult(raw, target.text);
      if (!text.trim() && target.text.trim()) throw new Error('El modelo no devolvió código.');
      applyInline(view, target.from, target.to, text);
      view.dispatch({ selection: { anchor: target.from + text.length } });
      setPhase('review');
    } catch (e) {
      if (e.name === 'AbortError') return;
      setError(String(e.message || e));
      setPhase('prompt');
      inputRef.current?.focus();
    }
  };

  if (phase === 'review') {
    return (
      <div className="inlineedit inlineedit--review" style={{ top }}>
        <LogoMark size={12} />
        <span className="inlineedit__label">{prompt}</span>
        <button className="btn btn--accent btn--sm" onClick={accept}>Aceptar <kbd>Ctrl ↵</kbd></button>
        <button className="btn btn--ghost btn--sm" onClick={reject}>Rechazar <kbd>Esc</kbd></button>
      </div>
    );
  }

  return (
    <div className="inlineedit" style={{ top }}>
      {phase === 'running' ? <SpinRing size={14} /> : <LogoMark size={13} />}
      <input
        ref={inputRef}
        autoFocus
        value={prompt}
        disabled={phase === 'running'}
        placeholder={target.text.trim() ? 'Cómo cambiar la selección…' : 'Qué escribir aquí…'}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); run(); }
          if (e.key === 'Escape') { e.preventDefault(); if (phase === 'running') abortRef.current?.abort(); close(); }
        }}
      />
      {error && <span className="inlineedit__error">{error}</span>}
      {phase === 'running'
        ? <button className="lk" onClick={() => { abortRef.current?.abort(); setPhase('prompt'); }}>Detener</button>
        : <button className="inlineedit__send" onClick={run} disabled={!prompt.trim()} aria-label="Enviar"><IconArrowUp size={13} /></button>}
    </div>
  );
}
