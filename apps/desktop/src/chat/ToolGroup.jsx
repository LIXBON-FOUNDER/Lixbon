// ToolGroup.jsx — agrupa las acciones del agente (tool calls) de un turno en un
// bloque plegable de "segundo plano", para que la respuesta importante destaque.
// Colapsado por defecto; al desplegarlo se ven las herramientas y sus diffs.
import { useChatStore } from '../store/chatStore';

function ToolRow({ message, index }) {
  const a = message.args || {};
  const target = a.path || a.pattern || (a.src ? `${a.src} → ${a.dst}` : '');
  const failed = message.ok === false;
  const change = message.change;
  const hasDiff = change && (change.sampleOld?.length > 0 || change.sampleNew?.length > 0);
  const hiddenLines = change
    ? Math.max(0, change.removed - (change.sampleOld?.length || 0)) +
      Math.max(0, change.added - (change.sampleNew?.length || 0))
    : 0;

  return (
    <div className={`toolrow ${failed ? 'is-err' : ''}`}>
      <div className="toolrow__line">
        <span className="toolrow__dot" aria-hidden>●</span>
        <span className="toolrow__name">{message.tool}</span>
        {target && <span className="toolrow__target">{target}</span>}
        {change && (change.added > 0 || change.removed > 0) && (
          <span className="toolrow__counts">
            {change.added > 0 && <em className="toolrow__add">+{change.added}</em>}
            {change.removed > 0 && <em className="toolrow__del">−{change.removed}</em>}
          </span>
        )}
      </div>
      {failed && <p className="toolrow__err">{message.content}</p>}
      {hasDiff && (
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
      {!failed && message.content && !hasDiff && (
        <p className="toolrow__result">{message.content}</p>
      )}
      {message.snapshot && !failed && (
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

const VERB = {
  read_file: 'leyó', write_file: 'escribió', edit_file: 'editó', append_file: 'añadió a',
  delete_file: 'eliminó', rename_file: 'movió', mkdir: 'creó carpeta', search: 'buscó',
  list_files: 'listó', run_command: 'ejecutó',
};

export function ToolGroup({ messages, startIndex }) {
  const failed = messages.some((m) => m.ok === false);
  // Resumen legible: "leyó app.js, editó app.js" (máx 3, luego "…")
  const parts = messages.slice(0, 3).map((m) => {
    const a = m.args || {};
    const what = a.path || a.pattern || a.command || a.src || '';
    return `${VERB[m.tool] || m.tool} ${what}`.trim();
  });
  const label = parts.join(', ') + (messages.length > 3 ? '…' : '');
  const count = messages.length;

  return (
    <details className={`toolgroup ${failed ? 'is-err' : ''}`}>
      <summary className="toolgroup__summary">
        <span className="toolgroup__chevron" aria-hidden>▸</span>
        <span className="toolgroup__icon" aria-hidden>⚙</span>
        <span className="toolgroup__count">{count} {count === 1 ? 'acción' : 'acciones'}</span>
        <span className="toolgroup__label">{label}</span>
        {failed && <span className="toolgroup__err">· con errores</span>}
      </summary>
      <div className="toolgroup__body">
        {messages.map((m, k) => (
          <ToolRow key={k} message={m} index={startIndex + k} />
        ))}
      </div>
    </details>
  );
}
