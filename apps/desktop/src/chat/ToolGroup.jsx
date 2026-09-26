// ToolGroup.jsx — actividad del agente: cada tool call es su propia fila,
// siempre visible (icono → check, verbo en español, ruta, +N/−N), como en
// el mockup. Nada queda oculto detrás de un "N acciones" plegado.
import { useState } from 'react';
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

function ActivityIcon({ pending, failed }) {
  return (
    <span className="activity-row__icon" aria-hidden>
      <span className={`activity-row__spinner ${pending ? 'is-visible' : ''}`} />
      <span className={`activity-row__check ${pending ? '' : 'is-visible'}`} />
    </span>
  );
}

/** La acción en curso se lee como una línea "en vivo": el mockup no muestra
    una tool call corriendo como una fila más, sino como texto que se
    escribe (punto pulsante + mono + cursor). Solo aplica al último tool
    call pendiente del turno — el resto de filas pendientes usa el spinner. */
function LiveRow({ message }) {
  const a = message.args || {};
  const status = message.content?.trim() || a.command || a.path || (VERB_GERUND[message.tool] || message.tool);
  return (
    <div className="activity-row activity-row--live">
      <span className="activity-row__dot" aria-hidden />
      <span className="activity-row__live-text">{status}</span>
      <span className="msg__caret" aria-hidden="true" />
    </div>
  );
}

function ActivityRow({ message, index, delay, live }) {
  const [showDiff, setShowDiff] = useState(false);
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

  if (live) return <LiveRow message={message} />;

  const verb = mcp
    ? `MCP · ${mcp.server}`
    : capitalize(pending ? (VERB_GERUND[message.tool] || message.tool) : (VERB[message.tool] || message.tool));

  return (
    <div className={`activity-row ${failed ? 'is-err' : ''}`} style={{ animationDelay: `${delay}ms` }}>
      <div className="activity-row__line">
        <ActivityIcon pending={pending} failed={failed} />
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
      {!failed && !pending && message.content && !hasDiff && (message.tool === 'run_command' || mcp) && (
        <p className="toolrow__result">{message.content}</p>
      )}
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

export function ToolGroup({ messages, startIndex }) {
  const lastPendingIdx = messages.reduce((acc, m, i) => (m.pending ? i : acc), -1);
  return (
    <div className="activity-group">
      {messages.map((m, k) => (
        <ActivityRow
          key={k}
          message={m}
          index={startIndex + k}
          delay={Math.min(k, 6) * 60}
          live={m.tool === 'run_command' && k === lastPendingIdx}
        />
      ))}
    </div>
  );
}
