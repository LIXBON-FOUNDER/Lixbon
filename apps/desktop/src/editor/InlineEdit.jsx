// InlineEdit.jsx — widget flotante de edición inline con IA (Ctrl+K).
// Se monta una vez en el AppShell y se muestra sobre la selección del editor.
// Al generar, reemplaza el rango y deja el diff inline (verde/rojo) para que el
// usuario acepte/rechace por bloque, igual que las ediciones del agente.
import { useState, useRef, useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import { useEditorStore } from '../store/editorStore';
import { runInlineEdit } from '../lib/inlineEdit';

export function InlineEdit() {
  const open = useAppStore((s) => s.inlineEditOpen);
  const [target, setTarget] = useState(null);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const abortRef = useRef(null);

  const close = () => useAppStore.getState().setInlineEditOpen(false);

  useEffect(() => {
    if (!open) { setTarget(null); return; }
    const t = useEditorStore.getState().getEditTarget();
    if (!t || !t.coords) { close(); return; }
    setTarget(t);
    setError('');
    setInstruction('');
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  if (!open || !target) return null;

  const submit = async () => {
    if (!instruction.trim() || busy) return;
    setBusy(true);
    setError('');
    abortRef.current = new AbortController();
    try {
      const newText = await runInlineEdit({
        fileName: target.name,
        code: target.text,
        instruction,
        signal: abortRef.current.signal,
      });
      if (!newText.trim()) throw new Error('El modelo no devolvió código.');
      useEditorStore.getState().applyInlineEdit(target.from, target.to, newText, target.doc);
      close();
    } catch (e) {
      if (e.name !== 'AbortError') setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    if (abortRef.current) abortRef.current.abort();
    close();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  const style = {
    top: Math.min((target.coords.bottom || target.coords.top) + 6, window.innerHeight - 120),
    left: Math.min(Math.max(8, target.coords.left), window.innerWidth - 400),
  };

  return (
    <div className="inline-edit" style={style} onPointerDown={(e) => e.stopPropagation()}>
      <div className="inline-edit__row">
        <span className="inline-edit__spark">✦</span>
        <input
          ref={inputRef}
          className="inline-edit__input"
          placeholder="Describe el cambio… (Enter genera, Esc cancela)"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy}
          spellCheck={false}
        />
        {busy ? (
          <button className="inline-edit__go" onClick={cancel}>Cancelar</button>
        ) : (
          <button className="inline-edit__go" onClick={submit}>Generar</button>
        )}
      </div>
      {busy && <p className="inline-edit__hint">Generando cambio con {useAppStore.getState().currentModel}…</p>}
      {error && <p className="inline-edit__err">{error}</p>}
    </div>
  );
}
