// PreviewOverlays.jsx — diálogos de la vista previa sobre el Modal del producto. Todo simulado.
import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { providerName } from '../../orch/agent/agentIdentity';
import { usePreviewStore, attemptById, taskOf, attemptsOfTask } from './previewStore';
import { PROJECTS, PROVIDERS, USAGE, POLICIES } from './previewData';
import { I } from './PreviewUi';
import { agentName, hostOf, MODES, attemptName } from './previewVocab';

function Field({ label, children, wide = false }) {
  return <label className={`pv-field${wide ? ' pv-field--wide' : ''}`}><span>{label}</span>{children}</label>;
}

function Actions({ children }) {
  return <div className="pv-modal__actions">{children}</div>;
}

function QuotaWarning({ provider, onSwitch }) {
  const use = USAGE.find((u) => u.provider === provider);
  if (!use || use.pct < 70) return null;
  const free = USAGE.find((u) => u.provider === 'codex');
  return (
    <div className="pv-callout">
      <span>{providerName(provider)} · {use.windowLabel}: {use.pct}% usado (se reinicia en {use.reset}). Codex tiene {100 - free.pct}% libre. Nunca se cambia sin decírtelo.</span>
      <button type="button" className="btn btn--ghost btn--sm" onClick={onSwitch}>Usar Codex</button>
    </div>
  );
}

function Fork({ ov, onClose }) {
  const s = usePreviewStore();
  const src = attemptById(s, ov.attemptId);
  const task = taskOf(s, src);
  const [prov, setProv] = useState(src.provider === 'claude' ? 'codex' : 'claude');
  const [model, setModel] = useState(PROVIDERS[prov].models[0]);
  const [host, setHost] = useState(src.host);
  const [policy, setPolicy] = useState(src.policy);
  const [text, setText] = useState(ov.text || '');
  const branch = src.readonly ? null : `${task.branchBase}-${prov}`;
  const next = String.fromCharCode(65 + attemptsOfTask(s, task.id).length);
  const setProvider = (p) => { setProv(p); setModel(PROVIDERS[p].models[0]); };
  return (
    <Modal title="Nuevo Intento en paralelo" subtitle={`${task.title} · el ${attemptName(src)} sigue en marcha`} onClose={onClose} size="sm">
      <p className="pv-modal__p">Arranca desde el mismo <b>ContextPackage {src.ctx}</b>, con su propio worktree.</p>
      <div className="pv-grid2">
        <Field label="Agente"><select className="pv-select" value={prov} onChange={(e) => setProvider(e.target.value)}>{Object.keys(PROVIDERS).map((p) => <option key={p} value={p}>{providerName(p)}</option>)}</select></Field>
        <Field label="Modelo"><select className="pv-select" value={model} onChange={(e) => setModel(e.target.value)}>{PROVIDERS[prov].models.map((m) => <option key={m}>{m}</option>)}</select></Field>
        <Field label="Ejecutar en"><select className="pv-select" value={host} onChange={(e) => setHost(e.target.value)}>{s.hosts.map((h) => <option key={h.id} value={h.id} disabled={h.status === 'offline'}>{h.name}{h.status === 'offline' ? ' · desconectado' : ''}</option>)}</select></Field>
        <Field label="Perfil de autonomía"><select className="pv-select" value={policy} onChange={(e) => setPolicy(e.target.value)}>{Object.entries(POLICIES).map(([id, l]) => <option key={id} value={id}>{l}</option>)}</select></Field>
      </div>
      <QuotaWarning provider={prov} onSwitch={() => setProvider('codex')} />
      <Field label="Instrucción (opcional)" wide><textarea className="pv-textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="El mismo objetivo de la Task, salvo que añadas un matiz…" /></Field>
      <p className="pv-muted"><I n="branch" size={12} /> Worktree nuevo: <span className="mono">{branch || 'ninguno (solo lectura)'}</span> en {hostOf(host).name}. El {attemptName(src)} no se toca.</p>
      <Actions>
        <button type="button" className="btn btn--ghost" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn btn--accent" onClick={() => s.fork({ attemptId: src.id, provider: prov, model, host, policy, text: text.trim() || undefined })}>Arrancar el Intento {next}</button>
      </Actions>
    </Modal>
  );
}

function ConfirmStop({ ov, onClose }) {
  const s = usePreviewStore();
  const a = attemptById(s, ov.attemptId);
  return (
    <Modal title="¿Detener y enviar?" subtitle={`${agentName(a)} · ${attemptName(a)}`} onClose={onClose} size="sm">
      <div className="pv-callout pv-tone-failed"><span>{MODES.stop.desc}</span></div>
      <p className="pv-modal__p">El turno en marcha se detiene ya. Luego se envía tu mensaje como un turno nuevo:</p>
      <blockquote className="pv-quote">{ov.text}</blockquote>
      <p className="pv-muted">¿Prefieres no perder el trabajo? Usa <b>En cola</b> (tras el turno) o <b>Corregir</b> (en un punto seguro).</p>
      <Actions>
        <button type="button" className="btn btn--ghost" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn btn--ghost" onClick={() => { s.send({ attemptId: a.id, text: ov.text, mode: 'steer', from: ov.from }); onClose(); }}>Corregir en su lugar</button>
        <button type="button" className="btn pv-btn--danger" onClick={() => { s.send({ attemptId: a.id, text: ov.text, mode: 'stop', from: ov.from }); onClose(); }}>Detener y enviar</button>
      </Actions>
    </Modal>
  );
}

function ReturnToAgent({ ov, onClose }) {
  const s = usePreviewStore();
  const [note, setNote] = useState('');
  return (
    <Modal title="Devolver al agente" subtitle="Misma Task, mismo Intento, mismo worktree" onClose={onClose} size="sm">
      <ul className="pv-insp__list">
        <li><I n="check" size={11} />3 archivos cambiados por ti · +42 / −7</li>
        <li><I n="check" size={11} />El ContextPackage pasa a la siguiente versión</li>
        <li><I n="check" size={11} />Queda registrado el cambio de actor (tú → agente)</li>
      </ul>
      <Field label="Nota para el agente (opcional)" wide><textarea className="pv-textarea" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Arreglé a mano las rutas; termina las pruebas." /></Field>
      <Actions>
        <button type="button" className="btn btn--ghost" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn btn--accent" onClick={() => { s.returnToAgent(ov.attemptId, note.trim()); onClose(); }}>Devolver al agente</button>
      </Actions>
    </Modal>
  );
}

function NewTask({ onClose }) {
  const s = usePreviewStore();
  const [project, setProject] = useState(s.sel.projectId);
  const [title, setTitle] = useState('');
  const [prov, setProv] = useState('codex');
  const [host, setHost] = useState('desktop');
  const [text, setText] = useState('');
  return (
    <Modal title="Nueva Task" subtitle="Una Task es un objetivo durable. Al empezarla se crea su primer Intento." onClose={onClose} size="sm">
      <div className="pv-grid2">
        <Field label="Project"><select className="pv-select" value={project} onChange={(e) => setProject(e.target.value)}>{PROJECTS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Agente"><select className="pv-select" value={prov} onChange={(e) => setProv(e.target.value)}>{Object.keys(PROVIDERS).map((p) => <option key={p} value={p}>{providerName(p)}</option>)}</select></Field>
        <Field label="Título" wide><input className="pv-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="p. ej. Límite de peticiones" autoFocus /></Field>
        <Field label="Ejecutar en"><select className="pv-select" value={host} onChange={(e) => setHost(e.target.value)}>{s.hosts.map((h) => <option key={h.id} value={h.id} disabled={h.status === 'offline'}>{h.name}{h.status === 'offline' ? ' · desconectado' : ''}</option>)}</select></Field>
        <Field label="Aislamiento"><select className="pv-select" disabled><option>Worktree propio</option></select></Field>
      </div>
      <QuotaWarning provider={prov} onSwitch={() => setProv('codex')} />
      <Field label="Objetivo" wide><textarea className="pv-textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="¿Qué debe ser cierto cuando esto termine?" /></Field>
      <Actions>
        <button type="button" className="btn btn--ghost" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn btn--accent" disabled={!title.trim()} onClick={() => { s.createTask({ projectId: project, title: title.trim(), provider: prov, host, objective: text.trim() }); onClose(); }}>Crear la Task y empezar</button>
      </Actions>
    </Modal>
  );
}

export function PreviewOverlays() {
  const ov = usePreviewStore((s) => s.overlay);
  const setOverlay = usePreviewStore((s) => s.setOverlay);
  if (!ov) return null;
  const onClose = () => setOverlay(null);
  if (ov.type === 'fork') return <Fork ov={ov} onClose={onClose} />;
  if (ov.type === 'confirmstop') return <ConfirmStop ov={ov} onClose={onClose} />;
  if (ov.type === 'return') return <ReturnToAgent ov={ov} onClose={onClose} />;
  if (ov.type === 'newtask') return <NewTask onClose={onClose} />;
  return null;
}
