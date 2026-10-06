// ToolGroup.jsx — actividad del agente en UNA línea por tramo de tool calls.
// Mientras corre, la línea cuenta en palabras lo que hace ahora («Revisando el
// diff»), con una ola de color que recorre las letras; al terminar queda el
// resumen («Ejecutó 3 comandos y leyó 2 archivos · +12 −4 · 4,2 s»). El
// detalle (comandos, salidas, diffs, revertir, reintentar) se despliega al
// pulsar: la conversación no se satura de filas.
import { useMemo, useState } from 'react';
import { describeTool, summarizeTools } from '../lib/toolText';
import { IconChevronRight } from '../components/Icons';
import { useChatStore } from '../store/chatStore';
import { useAppStore } from '../store/appStore';
import { absFromRoot, openFilePreview, previewKind } from '../lib/preview';

const WRITES = new Set(['write_file', 'edit_file', 'multi_edit', 'append_file', 'insert_at_line']);

function PreviewButton({ path }) {
  const root = useAppStore((s) => s.workspaceRoot);
  const kind = previewKind(path);
  return (
    <button className="activity-row__toggle activity-row__open" onClick={() => openFilePreview(absFromRoot(root, path))}>
      {kind === 'markdown' ? 'Vista previa' : 'Ver visual'}
    </button>
  );
}

const VERB = {
  read_file: 'leyó', write_file: 'escribió', edit_file: 'editó', append_file: 'añadió a',
  delete_file: 'eliminó', rename_file: 'movió', mkdir: 'creó carpeta', search: 'buscó',
  list_files: 'listó', run_command: 'ejecutó', ask_user: 'preguntó',
};

const VERB_GERUND = {
  read_file: 'leyendo', write_file: 'escribiendo', edit_file: 'editando', append_file: 'añadiendo a',
  delete_file: 'eliminando', rename_file: 'moviendo', mkdir: 'creando carpeta', search: 'buscando',
  list_files: 'listando', run_command: 'ejecutando', ask_user: 'esperando tu respuesta',
};

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export const fmtMs = (ms) => (ms < 10000 ? `${(ms / 1000).toFixed(1).replace('.', ',')} s` : `${Math.round(ms / 1000)} s`);

/** `mcp__github__create_issue` → { server: 'github', tool: 'create_issue' } */
const mcpParts = (tool) => {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool || '');
  return m ? { server: m[1], tool: m[2] } : null;
};

function ActivityIcon({ pending }) {
  return (
    <span className="activity-row__icon" aria-hidden>
      <span className={`activity-row__spinner ${pending ? 'is-visible' : ''}`} />
      <span className={`activity-row__check ${pending ? '' : 'is-visible'}`} />
    </span>
  );
}

function ActivityRow({ message, index, delay }) {
  const [showDiff, setShowDiff] = useState(false);
  const [showOut, setShowOut] = useState(false);
  const a = message.args || {};
  const mcp = mcpParts(message.tool);
  const target = message.tool === 'ask_user' ? '' : mcp ? mcp.tool : a.command || a.path || a.pattern || (a.src ? `${a.src} → ${a.dst}` : '');
  const pending = !!message.pending;
  const failed = message.ok === false;
  const change = message.change;
  const hasDiff = change && (change.sampleOld?.length > 0 || change.sampleNew?.length > 0);
  const hiddenLines = change
    ? Math.max(0, change.removed - (change.sampleOld?.length || 0)) +
      Math.max(0, change.added - (change.sampleNew?.length || 0))
    : 0;

  const verb = mcp
    ? `MCP · ${mcp.server}`
    : capitalize(pending ? (VERB_GERUND[message.tool] || message.tool) : (VERB[message.tool] || message.tool));

  return (
    <div className={`activity-row ${failed ? 'is-err' : ''}`} style={{ animationDelay: `${delay}ms` }}>
      <div className="activity-row__line">
        <ActivityIcon pending={pending} />
        <span className="activity-row__verb">{verb}</span>
        {target && <span className="activity-row__target">{target}</span>}
        {change && (change.added > 0 || change.removed > 0) && (
          <span className="activity-row__counts">
            {change.added > 0 && <span className="activity-row__add">+{change.added}</span>}
            {change.removed > 0 && <span className="activity-row__del">−{change.removed}</span>}
          </span>
        )}
        {hasDiff && (
          <button className="activity-row__toggle" onClick={() => setShowDiff((v) => !v)}>
            {showDiff ? 'Ocultar' : 'Ver'}
          </button>
        )}
        {!failed && !pending && message.content && !hasDiff && (message.tool === 'run_command' || mcp) && (
          <button className="activity-row__toggle" onClick={() => setShowOut((v) => !v)}>
            {showOut ? 'Ocultar salida' : 'Salida'}
          </button>
        )}
        {!pending && !failed && WRITES.has(message.tool) && previewKind(a.path) && <PreviewButton path={a.path} />}
        {!pending && message.ms >= 100 && <span className="activity-row__ms">{fmtMs(message.ms)}</span>}
      </div>
      {failed && message.content && (
        <p className="toolrow__err">
          {message.content}
          {message.content !== 'rechazado por el usuario' && (
            <button className="toolrow__retry" onClick={() => useChatStore.getState().retryTool(index)}>Reintentar</button>
          )}
        </p>
      )}
      {showDiff && hasDiff && (
        <pre className="toolrow__diff">
          {change.sampleOld.map((line, i) => (
            <span key={`o${i}`} className="diffline diffline--del">- {line}{'\n'}</span>
          ))}
          {change.sampleNew.map((line, i) => (
            <span key={`n${i}`} className="diffline diffline--add">+ {line}{'\n'}</span>
          ))}
          {hiddenLines > 0 && (
            <span className="diffline diffline--more">… +{hiddenLines} líneas más{'\n'}</span>
          )}
        </pre>
      )}
      {message.answers?.length > 0 && (
        <dl className="toolrow__answers">
          {message.answers.map((p, i) => (
            <div key={i}><dt>{p.question}</dt><dd>{p.answer}</dd></div>
          ))}
        </dl>
      )}
      {showOut && <p className="toolrow__result">{message.content}</p>}
      {message.snapshot && !failed && message.accepted && !message.reverted && <span className="toolrow__revert is-done">Aceptado ✓</span>}
      {message.snapshot && !failed && !message.accepted && (
        <button
          className="toolrow__revert"
          disabled={message.reverted}
          onClick={() => useChatStore.getState().revertTool(index)}
          title="Deshace este cambio en el disco (checkpoint)"
        >
          {message.reverted ? 'Revertido ✓' : 'Revertir'}
        </button>
      )}
    </div>
  );
}

/** Texto con una ola de color que recorre las letras (acción en curso). */
function WaveText({ text }) {
  const chars = [...(text.length > 90 ? `${text.slice(0, 89)}…` : text)];
  return (
    <span className="actline__text actline__wave" aria-label={text}>
      {chars.map((c, i) => <span key={i} aria-hidden="true" style={{ '--i': i }}>{c}</span>)}
    </span>
  );
}

const IS_FAIL = (m) => m.ok === false;

export function ToolGroup({ messages, startIndex }) {
  const [open, setOpen] = useState(false);
  const pendingIdx = messages.reduce((acc, m, i) => (m.pending ? i : acc), -1);
  const running = pendingIdx >= 0;
  const failed = messages.filter(IS_FAIL).length;
  const done = messages.filter((m) => !m.pending).length;
  const { added, removed, ms } = useMemo(() => messages.reduce((t, m) => ({
    added: t.added + (m.change?.added || 0),
    removed: t.removed + (m.change?.removed || 0),
    ms: t.ms + (m.ms || 0),
  }), { added: 0, removed: 0, ms: 0 }), [messages]);
  const text = running ? describeTool(messages[pendingIdx]) : summarizeTools(messages);
  const answered = messages.filter((m) => m.answers?.length > 0);

  return (
    <div className={`actline-group ${open ? 'is-open' : ''}`}>
      <button
        className={`actline ${running ? 'is-running' : ''} ${failed && !running ? 'is-err' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? 'Ocultar el detalle' : 'Ver el detalle'}
      >
        <span className="actline__icon" aria-hidden="true">
          {running ? <span className="actline__pulse" /> : <span className={`actline__mark ${failed ? 'is-err' : ''}`} />}
        </span>
        {running ? <WaveText key={text} text={text} /> : <span className="actline__text">{text}</span>}
        <span className="actline__meta">
          {running && messages.length > 1 && <span className="actline__step">{done + 1} de {messages.length}</span>}
          {!running && (added > 0 || removed > 0) && (
            <span className="actline__counts">
              {added > 0 && <span className="activity-row__add">+{added}</span>}
              {removed > 0 && <span className="activity-row__del">−{removed}</span>}
            </span>
          )}
          {!running && failed > 0 && <span className="actline__fail">{failed === 1 ? '1 falló' : `${failed} fallaron`}</span>}
          {!running && ms >= 100 && <span className="actline__ms">{fmtMs(ms)}</span>}
        </span>
        <span className={`actline__chev ${open ? 'is-open' : ''}`} aria-hidden="true"><IconChevronRight size={12} /></span>
      </button>
      {open && (
        <div className="actline__detail">
          {messages.map((m, k) => (
            <ActivityRow key={k} message={m} index={startIndex + k} delay={Math.min(k, 6) * 30} />
          ))}
        </div>
      )}
      {!open && answered.map((m, k) => (
        <dl key={k} className="toolrow__answers">
          {m.answers.map((p, i) => <div key={i}><dt>{p.question}</dt><dd>{p.answer}</dd></div>)}
        </dl>
      ))}
    </div>
  );
}
