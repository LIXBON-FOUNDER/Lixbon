// ClaudeCards.jsx — tarjetas de los "/" de Claude Code que resuelve Lixbon
// (/status, /cost, /help, /skills, /permissions, /hooks, /memory, /doctor) y
// la de `/config`.
import { Fragment } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useChatStore } from '../store/chatStore';
import { useAppStore } from '../store/appStore';
import { useFileViewStore } from '../store/fileViewStore';
import { writeFileContent } from '../lib/tauri';
import { CLAUDE_MODES } from '../lib/claudeCode';
import { SCOPE_ES } from '../lib/claudeCommands';
import { claudeSlashCommands, GROUP_LABELS } from './slashCommands';

const modeLabel = (id) => CLAUDE_MODES.find((m) => m.id === id)?.label || id;
const baseName = (p) => String(p || '').split(/[\\/]/).pop();
const insideRoot = (root, p) => !!root && String(p).toLowerCase().startsWith(String(root).toLowerCase());
const shortPath = (root, p) => (insideRoot(root, p) ? String(p).slice(String(root).length).replace(/^[\\/]/, '').replace(/\\/g, '/') : `~/.claude/${baseName(p)}`);

// Los archivos de la carpeta de trabajo se abren en el editor; los globales
// (~/.claude) quedan fuera de él y se abren con la app del sistema.
async function openConfigFile(path, exists, empty = '') {
  const root = useAppStore.getState().workspaceRoot || '';
  if (insideRoot(root, path)) {
    if (!exists) await writeFileContent(path, empty, null);
    await useFileViewStore.getState().open(path);
    return;
  }
  await invoke('cc_config_open', { cwd: root, path });
}

function Row({ label, children, title }) {
  return (
    <div className="cckv__row">
      <span className="cckv__key">{label}</span>
      <span className="cckv__val" title={title}>{children}</span>
    </div>
  );
}

function StatusCard({ status }) {
  const a = status.account;
  const mcpOk = status.mcp.filter((m) => m.status === 'connected').length;
  return (
    <div className="cccard">
      <div className="ccusage__label">Estado de Claude Code</div>
      <div className="cckv">
        <Row label="Versión">{status.version || '—'}</Row>
        <Row label="Cuenta">{a?.email ? `${a.email}${a.subscriptionType ? ` · ${a.subscriptionType}` : ''}` : 'Se conoce al arrancar la sesión'}</Row>
        <Row label="Modelo">{status.model}</Row>
        <Row label="Modo">{modeLabel(status.mode)}</Row>
        <Row label="Esfuerzo">{status.effort}</Row>
        <Row label="Carpeta" title={status.cwd}>{baseName(status.cwd) || '—'}</Row>
        <Row label="Sesión">{status.session ? status.session.slice(0, 8) : 'Nueva, aún sin mensajes'}</Row>
        {status.tools != null && <Row label="Herramientas">{status.tools}</Row>}
        <Row label="MCP">{status.mcp.length ? `${mcpOk} de ${status.mcp.length} conectados` : 'Se conoce tras el primer mensaje'}</Row>
      </div>
    </div>
  );
}

const usd = (n) => `$${n.toFixed(n >= 1 ? 2 : 4)}`;

function CostCard({ cost }) {
  const ctx = cost.context || {};
  const pct = ctx.window ? Math.round((ctx.used / ctx.window) * 100) : 0;
  return (
    <div className="cccard">
      <div className="ccusage__row">
        <span className="ccusage__label">Esta sesión</span>
        <span className="ccusage__pct cccard__value">{usd(cost.usd)}</span>
      </div>
      {cost.plan && <p className="cccard__body">Con tu plan ({cost.plan}) no pagas por token: es lo que costaría en la API. Lo que cuenta es tu cupo.</p>}
      <div className="ccusage__limit">
        <div className="ccusage__row">
          <span className="ccusage__label">Contexto</span>
          <span className="ccusage__pct">{Math.round((ctx.used || 0) / 1000)}k / {Math.round((ctx.window || 0) / 1000)}k · {pct}%</span>
        </div>
        <div className="ccusage__bar"><span style={{ width: `${Math.min(100, pct)}%` }} /></div>
      </div>
      {[['Sesión del plan (5 h)', cost.session], ['Semana', cost.week]].filter(([, w]) => w).map(([label, w]) => (
        <div key={label} className={`ccusage__limit${w.percent >= 80 ? ' ccusage__limit--warn' : ''}`}>
          <div className="ccusage__row">
            <span className="ccusage__label">{label}</span>
            <span className="ccusage__pct">{w.percent}%</span>
          </div>
          <div className="ccusage__bar"><span style={{ width: `${Math.min(100, w.percent)}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

function HelpCard({ onChoose }) {
  const commands = useChatStore((s) => s.ccCommands);
  const list = claudeSlashCommands(commands);
  const pick = (c) => {
    if (c.run) { c.run(); return; }
    if (c.claude && c.direct) { onChoose(`/${c.cmd}`); return; }
    window.dispatchEvent(new CustomEvent('lixbon:restore-drafts', { detail: { drafts: [{ text: `/${c.cmd} `, images: [], mentions: [] }] } }));
  };
  return (
    <div className="cccard cccard--wide">
      <div className="ccusage__row">
        <span className="ccusage__label">Comandos "/"</span>
        <span className="ccusage__pct">{list.length}</span>
      </div>
      <div className="cchelp">
        {list.map((c, i) => (
          <Fragment key={c.cmd}>
            {c.group !== list[i - 1]?.group && <div className="cchelp__group">{GROUP_LABELS[c.group]}</div>}
            <button className="cchelp__row" onClick={() => pick(c)} title={c.desc}>
              <span className="cchelp__cmd">/{c.cmd}{c.hint && <span className="cchelp__hint"> {c.hint}</span>}</span>
              <span className="cchelp__desc">{c.desc}</span>
            </button>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function SkillsCard({ skills, onChoose }) {
  const groups = [...new Set(skills.map((s) => s.source))];
  return (
    <div className="cccard cccard--wide">
      <div className="ccusage__row">
        <span className="ccusage__label">Skills</span>
        <span className="ccusage__pct">{skills.length}</span>
      </div>
      {!skills.length && <p className="cccard__body">No hay skills instaladas.</p>}
      <div className="cchelp">
        {groups.map((g) => (
          <Fragment key={g}>
            <div className="cchelp__group">{g}</div>
            {skills.filter((s) => s.source === g).map((s) => (
              <div key={s.name} className="cchelp__row is-static" title={s.desc}>
                <span className="cchelp__cmd">/{s.name}</span>
                <span className="cchelp__desc">{s.desc}</span>
              </div>
            ))}
          </Fragment>
        ))}
      </div>
      <div className="cccmd__choices">
        <button className="cccmd__choice" onClick={() => onChoose('/skill-doctor')}>Ver cuánto contexto ocupa cada una</button>
      </div>
    </div>
  );
}

function FileLinks({ files }) {
  const shown = files.filter((f) => f.exists);
  if (!shown.length) return null;
  return (
    <div className="cccmd__choices">
      {shown.map((f) => (
        <button key={f.path} className="cccmd__choice" title={f.path} onClick={() => openConfigFile(f.path, true)}>
          {SCOPE_ES[f.scope]} · {baseName(f.path)}
        </button>
      ))}
    </div>
  );
}

const RULE_KINDS = [['allow', 'Sin preguntar', 'ok'], ['ask', 'Siempre pregunta', 'warn'], ['deny', 'Bloqueado', 'bad']];

function PermissionsCard({ permissions: p }) {
  return (
    <div className="cccard cccard--wide">
      <div className="ccusage__row">
        <span className="ccusage__label">Permisos</span>
        <span className="ccusage__pct cccard__value">Modo {modeLabel(p.mode)}</span>
      </div>
      {p.defaultMode && <p className="cccard__body">Modo por defecto en los ajustes: {modeLabel(p.defaultMode.mode)} ({SCOPE_ES[p.defaultMode.scope]}).</p>}
      {p.errors.map((e) => <p key={e.path} className="ccdock__error">{baseName(e.path)} no es JSON válido: {e.error}</p>)}
      {!p.rules.length && <p className="cccard__body">No hay reglas: Claude pregunta según el modo de la sesión.</p>}
      {RULE_KINDS.map(([kind, label, tone]) => {
        const rules = p.rules.filter((r) => r.kind === kind);
        if (!rules.length) return null;
        return (
          <div key={kind}>
            <div className="cchelp__group"><i className={`ccdot ccdot--${tone}`} /> {label} · {rules.length}</div>
            <ul className="cccard__list">
              {rules.map((r, i) => (
                <li key={i}>
                  <span className="cccard__name mono">{r.rule}</span>
                  <span className="cccard__meta" />
                  <span className="cccard__status">{SCOPE_ES[r.scope]}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {p.dirs.length > 0 && <p className="cccard__body">Carpetas extra: {p.dirs.map((d) => d.dir).join(', ')}</p>}
      <FileLinks files={p.files} />
    </div>
  );
}

function HooksCard({ hooks }) {
  const events = [...new Set(hooks.rows.map((r) => r.event))];
  return (
    <div className="cccard cccard--wide">
      <div className="ccusage__row">
        <span className="ccusage__label">Hooks</span>
        <span className="ccusage__pct">{hooks.disabled ? 'desactivados' : hooks.rows.length}</span>
      </div>
      {!hooks.rows.length && <p className="cccard__body">No hay hooks configurados.</p>}
      {events.map((ev) => (
        <div key={ev}>
          <div className="cchelp__group">{ev}</div>
          <ul className="cccard__list">
            {hooks.rows.filter((r) => r.event === ev).map((r, i) => (
              <li key={i} title={r.command}>
                {r.matcher && <span className="cchook__matcher">{r.matcher}</span>}
                <span className="cccard__meta mono">{r.command}</span>
                <span className="cccard__status">{SCOPE_ES[r.scope]}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <FileLinks files={hooks.files} />
    </div>
  );
}

function MemoryCard({ memory }) {
  const root = useAppStore((s) => s.workspaceRoot);
  return (
    <div className="cccard">
      <div className="ccusage__label">Memoria de Claude (CLAUDE.md)</div>
      <p className="cccard__body">Claude Code la lee al empezar cada conversación.</p>
      <ul className="cccard__list">
        {memory.map((m) => (
          <li key={m.path} title={m.path}>
            <i className={`ccdot ${m.exists ? 'ccdot--ok' : ''}`} />
            <span className="cccard__name">{SCOPE_ES[m.scope]}</span>
            <span className="cccard__meta mono">{shortPath(root, m.path)}{m.exists ? ` · ${m.lines} líneas · ~${m.tokens.toLocaleString('es')} tokens` : ''}</span>
            <button className="lk is-accent" onClick={() => openConfigFile(m.path, m.exists)}>{m.exists ? 'Abrir' : 'Crear'}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DoctorCard({ checks }) {
  const bad = checks.filter((c) => c.tone !== 'ok').length;
  return (
    <div className="cccard">
      <div className="ccusage__row">
        <span className="ccusage__label">Diagnóstico</span>
        <span className={`ccusage__pct cccard__status ${bad ? 'is-warn' : 'is-ok'}`}>{bad ? `${bad} por revisar` : 'Todo en orden'}</span>
      </div>
      <ul className="ccdoc">
        {checks.map((c) => (
          <li key={c.label}>
            <i className={`ccdot ccdot--${c.tone}`} />
            <div>
              <div className="ccdoc__label">{c.label}</div>
              <div className="ccdoc__detail">{c.detail}</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConfigCard({ options }) {
  return (
    <div className="cccard cccard--wide">
      <div className="ccusage__label">Ajustes de Claude Code</div>
      <p className="cccard__body">Se cambian con /config clave=valor y son globales: afectan a todas tus sesiones de Claude Code.</p>
      <div className="cccard__scroll">
        <table className="cccard__table">
          <tbody>
            {options.map((o) => (
              <tr key={o.key}>
                <td>{o.key}</td>
                <td>{o.values ? o.values.join(' · ') : 'texto libre'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** La tarjeta propia de Lixbon para este "/", o null si no tiene. */
export function IdeCard({ card, onChoose }) {
  if (card.status) return <StatusCard status={card.status} />;
  if (card.cost) return <CostCard cost={card.cost} />;
  if (card.help) return <HelpCard onChoose={onChoose} />;
  if (card.skills) return <SkillsCard skills={card.skills} onChoose={onChoose} />;
  if (card.permissions) return <PermissionsCard permissions={card.permissions} />;
  if (card.hooks) return <HooksCard hooks={card.hooks} />;
  if (card.memory) return <MemoryCard memory={card.memory} />;
  if (card.doctor) return <DoctorCard checks={card.doctor} />;
  if (card.options) return <ConfigCard options={card.options} />;
  return null;
}
