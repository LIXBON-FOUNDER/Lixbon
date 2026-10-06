// ChatMessage.jsx — una burbuja del chat (usuario / asistente / error).
// Las filas de herramienta se agrupan aparte en ToolGroup (las llama ChatPanel).
import { memo, useEffect, useState } from 'react';
import { ChatMarkdown } from './ChatMarkdown';
import { useChatStore } from '../store/chatStore';
import { IconGlobe, IconFileCode, IconCheck } from '../components/Icons';
import { ClaudeMark } from '../components/Logo';
import { IdeCard } from './ClaudeCards';
import { splitDocs } from '../lib/docBlocks';

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

const TASK_LABEL = { local_bash: 'comando', local_agent: 'subagente', remote_agent: 'agente remoto' };

function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const elapsed = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
};

export function WaitingLive({ tasks }) {
  const now = useNow();
  return (
    <div className="compact compact--live waiting" role="status">
      <div className="compact__head">
        <ClaudeMark size={13} className="claudemark--live" />
        <span className="compact__label">
          {tasks.length === 1 ? 'Esperando a una tarea en segundo plano…' : `Esperando a ${tasks.length} tareas en segundo plano…`}
        </span>
      </div>
      <ul className="waiting__list">
        {tasks.map((t) => (
          <li key={t.id}>
            <span className="waiting__kind mono">{TASK_LABEL[t.type] || 'tarea'}</span>
            <span className="waiting__desc">{t.description || t.id}</span>
            <span className="msg__live-secs mono">{elapsed(now - t.since)}</span>
          </li>
        ))}
      </ul>
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

function UsageCard({ usage }) {
  const intro = /subscription/i.test(usage.intro) ? 'Con tu suscripción de Claude' : usage.intro;
  return (
    <div className="ccusage">
      {intro && <div className="ccusage__intro">{intro}</div>}
      <div className="ccusage__limits">
        {usage.limits.map((l) => {
          const pct = Math.min(100, l.percent);
          const tone = l.percent >= 100 ? 'full' : l.percent >= 80 ? 'warn' : '';
          return (
            <div key={l.key} className={`ccusage__limit${tone ? ` ccusage__limit--${tone}` : ''}`}>
              <div className="ccusage__row">
                <span className="ccusage__label">{l.label}</span>
                <span className="ccusage__pct">{l.percent}%</span>
              </div>
              <div className="ccusage__bar"><span style={{ width: `${pct}%` }} /></div>
              <div className="ccusage__reset">{l.resets ? `Se reinicia ${l.resets}` : l.percent === 0 ? 'Sin uso en esta ventana' : ''}</div>
            </div>
          );
        })}
      </div>
      {usage.periods.length > 0 && (
        <details className="ccusage__more">
          <summary>Qué está consumiendo tu cupo</summary>
          <div className="ccusage__periods">
            {usage.periods.map((p) => (
              <div key={p.label} className="ccusage__period">
                <div className="ccusage__row">
                  <span className="ccusage__label">{p.label}</span>
                  <span className="ccusage__stats">{p.stats}</span>
                </div>
                <ul>{p.items.map((it, i) => <li key={i}>{it}</li>)}</ul>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

const CTX_TONES = {
  messages: '#D97757',
  'system prompt': '#8A8F98',
  'system tools': '#6E9BD1',
  'system tools (deferred)': '#4E6E96',
  'mcp tools': '#9C7BD1',
  'mcp tools (deferred)': '#6C5896',
  'mcp server instructions': '#B69BE0',
  'memory files': '#7FB58A',
  'custom agents': '#D1B36E',
  skills: '#5FB3B3',
};

function ContextCard({ context }) {
  const parts = context.categories.filter((c) => c.key !== 'free space' && c.tokens > 0);
  const free = context.categories.find((c) => c.key === 'free space');
  return (
    <div className="ccctx">
      <div className="ccusage__row">
        <span className="ccusage__label">{context.model || 'Contexto'}</span>
        <span className="ccusage__pct">{context.usedText} / {context.totalText} · {context.pct}%</span>
      </div>
      <div className="ccctx__bar">
        {parts.map((c) => <span key={c.key} style={{ width: `${c.pct}%`, background: c.key === 'autocompact buffer' ? undefined : CTX_TONES[c.key] || '#8A8F98' }} className={c.key === 'autocompact buffer' ? 'is-reserve' : ''} title={`${c.label} · ${c.text}`} />)}
      </div>
      <ul className="ccctx__legend">
        {[...parts, ...(free ? [free] : [])].map((c) => (
          <li key={c.key}>
            <i className={c.key === 'autocompact buffer' ? 'is-reserve' : c.key === 'free space' ? 'is-free' : ''} style={CTX_TONES[c.key] ? { background: CTX_TONES[c.key] } : undefined} />
            <span>{c.label}</span>
            <span className="ccctx__num">{c.text}</span>
          </li>
        ))}
      </ul>
      {context.details && (
        <details className="ccusage__more">
          <summary>Detalle por skill, herramienta y servidor</summary>
          <div className="ccctx__details"><ChatMarkdown>{context.details}</ChatMarkdown></div>
        </details>
      )}
    </div>
  );
}

// Solo /context y similares traen markdown de verdad; el resto son líneas
// alineadas en columnas que el markdown desharía.
const looksMarkdown = (t) => /^(#{1,4} |\|.*\|)/m.test(t);
const plain = (t) => t.replace(/`([^`\n]+)`/g, '$1');

function McpCard({ servers }) {
  if (!servers.length) return <div className="cccmd__out cccmd__out--empty">No hay servidores MCP configurados.</div>;
  const ok = servers.filter((s) => s.tone === 'ok').length;
  return (
    <div className="cccard">
      <div className="ccusage__row">
        <span className="ccusage__label">Servidores MCP</span>
        <span className="ccusage__pct">{ok} de {servers.length} conectados</span>
      </div>
      <ul className="cccard__list">
        {servers.map((s) => (
          <li key={s.name}>
            <i className={`ccdot ccdot--${s.tone}`} />
            <span className="cccard__name">{s.name}</span>
            <span className="cccard__meta">{[s.kind, s.scope].filter(Boolean).join(' · ')}</span>
            <span className={`cccard__status is-${s.tone}`}>{s.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AgentsCard({ agents }) {
  return (
    <div className="cccard">
      <div className="ccusage__row">
        <span className="ccusage__label">Sesiones de Claude abiertas</span>
        <span className="ccusage__pct">{agents.others.length + 1}</span>
      </div>
      <ul className="cccard__list">
        <li>
          <i className="ccdot ccdot--ok" />
          <span className="cccard__name">{agents.self}</span>
          <span className="cccard__meta">esta sesión</span>
        </li>
        {agents.others.map((a) => (
          <li key={a.name}>
            <i className={`ccdot ccdot--${a.tone}`} />
            <span className="cccard__name">{a.name}</span>
            <span className="cccard__meta" title={a.cwd}>{a.cwd.split(/[\\/]/).pop()} · {a.started}</span>
            <span className={`cccard__status is-${a.tone}`}>{a.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TableCard({ table }) {
  return (
    <div className="cccard cccard--wide">
      {table.title && <div className="ccusage__label">{table.title}</div>}
      <div className="cccard__scroll">
        <table className="cccard__table">
          <thead><tr>{table.header.map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>
            {table.rows.map((r, i) => (
              <tr key={i} className={/^never$/i.test(r[r.length - 1]) ? 'is-idle' : ''}>
                {r.map((c, k) => <td key={k}>{c}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.notes && (
        <details className="ccusage__more">
          <summary>Cómo leer la tabla</summary>
          <pre className="cccard__notes">{table.notes}</pre>
        </details>
      )}
    </div>
  );
}

function SettingCard({ setting }) {
  return (
    <div className="cccard">
      <div className="ccusage__row">
        <span className="ccusage__label">{setting.key}</span>
        <span className="ccusage__pct cccard__value">{setting.value}</span>
      </div>
      {setting.body && <p className="cccard__body">{setting.body}</p>}
    </div>
  );
}

/** Salida de un "/" de Claude Code con su tarjeta; la comparten el chat y la
    respuesta al margen de la caja. */
export function CommandOutput({ card, onChoose }) {
  const { name, output, choices } = card;
  const ide = IdeCard({ card, onChoose });
  return (
    <>
      {ide || (card.usage ? <UsageCard usage={card.usage} />
        : card.context ? <ContextCard context={card.context} />
          : card.mcp ? <McpCard servers={card.mcp} />
            : card.agents ? <AgentsCard agents={card.agents} />
              : card.table ? <TableCard table={card.table} />
                : card.setting ? <SettingCard setting={card.setting} />
                  : output ? (
                    <div className="cccmd__out">
                      {looksMarkdown(output) ? <ChatMarkdown>{output}</ChatMarkdown> : <pre>{plain(output)}</pre>}
                    </div>
                  ) : <div className="cccmd__out cccmd__out--empty">Hecho, sin salida.</div>)}
      {choices?.length > 0 && (
        <div className="cccmd__choices">
          {choices.map((c) => (
            <button key={c.value} className={`cccmd__choice${c.current ? ' is-current' : ''}`} title={c.desc || `/${name} ${c.value}`} onClick={() => onChoose(`/${name} ${c.value}`)}>
              {c.value}{c.current && <IconCheck size={11} />}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function CommandCard({ message }) {
  const send = useChatStore((s) => s.send);
  const { name, args } = message;
  return (
    <div className="msg cccmd">
      <CommandOutput card={message} onChoose={send} />
      <div className="cccmd__foot">/{name}{args ? ` ${args}` : ''} · {message.ide ? 'resuelto por Lixbon' : 'local'}, sin gastar tokens</div>
    </div>
  );
}

export const ChatMessage = memo(function ChatMessage({ message, streaming }) {
  if (message.role === 'cmd') return <CommandCard message={message} />;
  if (message.role === 'user' && message.command) {
    return (
      <div className="msg msg--user msg--cmd">
        <span className="msg__cmdname">/{message.command.name}</span>
        {message.command.args && <span className="msg__cmdargs">{message.command.args}</span>}
      </div>
    );
  }
  if (message.role === 'user') {
    const { docs, text } = splitDocs(message.content);
    return (
      <div className="msg msg--user">
        {message.context && (
          <span className="msg__ctx" title="Se adjuntó como contexto">
            <IconFileCode size={12} />
            {message.context.name}
            {message.context.selection ? ' (selección)' : ''}
          </span>
        )}
        {docs.map((name, i) => (
          <span key={`d${i}`} className="msg__ctx" title="Documento adjunto">
            <IconFileCode size={12} />
            {name}
          </span>
        ))}
        {message.mentions?.map((name, i) => (
          <span key={`m${i}`} className="msg__ctx" title="Archivo mencionado">@{name}</span>
        ))}
        {message.images?.length > 0 && (
          <div className="msg__images">
            {message.images.map((src, i) => (
              <img key={i} src={src} alt={`adjunto ${i + 1}`} />
            ))}
          </div>
        )}
        {text}
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
      {message.usage ? (
        <UsageCard usage={message.usage} />
      ) : message.content ? (
        <>
          <ChatMarkdown>{message.content}</ChatMarkdown>
          {streaming && <span className="msg__caret" aria-hidden="true" />}
        </>
      ) : message.generating ? (
        <LiveStatus text={`Generando cambio… (${(message.generating / 1000).toFixed(1)}k caracteres)`} />
      ) : (
        streaming && (message.engine === 'claude' ? <ClaudeLive /> : <LiveStatus text="Pensando…" />)
      )}
      {message.plan && !streaming && <PlanActions />}
    </div>
  );
});
