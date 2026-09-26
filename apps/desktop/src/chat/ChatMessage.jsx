// ChatMessage.jsx — una burbuja del chat (usuario / asistente / error).
// Las filas de herramienta se agrupan aparte en ToolGroup (las llama ChatPanel).
import { memo, useEffect, useState } from 'react';
import { ChatMarkdown } from './ChatMarkdown';
import { useChatStore } from '../store/chatStore';
import { IconGlobe, IconFileCode } from '../components/Icons';
import { ClaudeMark } from '../components/Logo';

/** Línea "en vivo" del agente entre acciones: punto pulsante + texto mono +
    cursor parpadeante, como la última línea del mockup. */
function LiveStatus({ text }) {
  return (
    <div className="msg__live">
      <span className="activity-row__dot" aria-hidden />
      <span className="msg__live-text">{text}</span>
      <span className="msg__caret" aria-hidden="true" />
    </div>
  );
}

const CLAUDE_VERBS = ['Pensando', 'Cavilando', 'Tramando', 'Hilando', 'Maquinando', 'Rumiando', 'Destilando', 'Cocinando', 'Descifrando', 'Tejiendo'];

// El indicador de Claude Code en su propio estilo: asterisco que late y un
// verbo que va cambiando, como en su terminal.
function ClaudeLive() {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.floor((now - start) / 1000);
  const verb = CLAUDE_VERBS[Math.floor(secs / 3) % CLAUDE_VERBS.length];
  return (
    <div className="msg__live msg__live--claude">
      <ClaudeMark size={13} className="claudemark--live" />
      <span className="msg__live-text">{verb}…</span>
      {secs >= 3 && <span className="msg__live-secs mono">{secs} s</span>}
    </div>
  );
}

export function CompactLive({ since }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.floor((now - since) / 1000));
  return (
    <div className="compact compact--live" role="status">
      <div className="compact__head">
        <ClaudeMark size={13} className="claudemark--live" />
        <span className="compact__label">Compactando la conversación…</span>
        {secs >= 2 && <span className="msg__live-secs mono">{secs} s</span>}
      </div>
      <div className="compact__bar"><span /></div>
    </div>
  );
}

const fmtTokens = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function CompactDivider({ message }) {
  const bits = [
    message.trigger === 'auto' ? 'automáticamente' : null,
    message.preTokens ? `${fmtTokens(message.preTokens)} tokens resumidos` : null,
    message.ms ? `${Math.max(1, Math.round(message.ms / 1000))} s` : null,
  ].filter(Boolean);
  return (
    <div className="compact">
      <div className="compact__rule">
        <span>Conversación compactada{bits.length ? ` · ${bits.join(' · ')}` : ''}</span>
      </div>
      {message.summary && (
        <details className="compact__summary">
          <summary>Ver resumen</summary>
          <div className="compact__body"><ChatMarkdown>{message.summary}</ChatMarkdown></div>
        </details>
      )}
    </div>
  );
}

function PlanActions() {
  const runPlan = useChatStore((s) => s.runPlan);
  const busy = useChatStore((s) => s.streaming);
  const focus = () => document.querySelector('.chat-inputbar__textarea')?.focus();
  return (
    <div className="planbar">
      <span className="planbar__text">¿Lo ejecuto? Pasará a modo Agente.</span>
      <button className="planbar__alt" onClick={focus}>Ajustar el plan</button>
      <button className="pill-btn pill-btn--primary planbar__go" disabled={busy} onClick={runPlan}>Ejecutar plan</button>
    </div>
  );
}

export const ChatMessage = memo(function ChatMessage({ message, streaming }) {
  if (message.role === 'user') {
    return (
      <div className="msg msg--user">
        {message.context && (
          <span className="msg__ctx" title="Se adjuntó como contexto">
            <IconFileCode size={12} />
            {message.context.name}
            {message.context.selection ? ' (selección)' : ''}
          </span>
        )}
        {message.images?.length > 0 && (
          <div className="msg__images">
            {message.images.map((src, i) => (
              <img key={i} src={src} alt={`adjunto ${i + 1}`} />
            ))}
          </div>
        )}
        {message.content}
      </div>
    );
  }

  if (message.role === 'error') {
    return <div className="msg msg--error">{message.content}</div>;
  }

  // Aviso del propio IDE (contexto recortado, tope de pasos…): no es del
  // modelo ni un error, pero el usuario tiene que verlo — sin esto el agente
  // se paraba y no había ninguna pista de por qué.
  if (message.role === 'compact') return <CompactDivider message={message} />;

  if (message.role === 'note') {
    return <div className="msg msg--note">{message.content}</div>;
  }

  return (
    <div className="msg msg--assistant">
      <div className="msg__agent">
        {message.engine === 'claude'
          ? <ClaudeMark size={16} className="msg__agent-logo" />
          : <img src="/favicon.svg" alt="" className="msg__agent-logo" draggable={false} />}
        <span className="msg__agent-name">{message.engine === 'claude' ? 'Claude Code' : 'Agente'}</span>
      </div>
      {message.thinking && (
        <details className="msg-think">
          <summary className="msg-think__summary">
            {message.thinkMs != null ? `Pensó ${Math.max(1, Math.round(message.thinkMs / 1000))} s` : 'Pensando…'}
          </summary>
          <div className="msg-think__body">{message.thinking}</div>
        </details>
      )}
      {message.sources?.length > 0 && (
        <div className="msg-sources">
          <span className="msg-sources__title"><IconGlobe size={13} /> Fuentes</span>
          <ol className="msg-sources__list">
            {message.sources.map((s, i) => (
              <li key={i}><a href={s.url} target="_blank" rel="noreferrer">{s.title || s.url}</a></li>
            ))}
          </ol>
        </div>
      )}
      {message.content ? (
        <>
          <ChatMarkdown>{message.content}</ChatMarkdown>
          {streaming && <span className="msg__caret" aria-hidden="true" />}
        </>
      ) : message.vision ? (
        <LiveStatus text="Analizando la imagen…" />
      ) : message.generating ? (
        <LiveStatus text={`Generando cambio… (${(message.generating / 1000).toFixed(1)}k caracteres)`} />
      ) : (
        streaming && (message.engine === 'claude' ? <ClaudeLive /> : <LiveStatus text="Pensando…" />)
      )}
      {message.plan && !streaming && <PlanActions />}
    </div>
  );
});
