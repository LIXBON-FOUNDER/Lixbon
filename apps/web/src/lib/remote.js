// Mismo protocolo y reducción que la app móvil (apps/mobile/src/remote.js).

import { hasValidSeq, reduceRemoteOrchEvent } from './remoteOrchReducer.js';
import { sanitizePrUrl } from './remotePrUrl.js';

// Tres latidos del gateway (SSE_PING_SECONDS = 15) sin recibir nada.
const SILENCIO_MS = 50000;

export function openEventStream({ path, signal, onEvent }) {
  // Devuelve una promesa que termina cuando el stream se corta (el llamador
  // decide reconectar). La auth es la cookie de sesión (same-origin): el
  // acceso remoto siempre exige al dueño autenticado.
  return (async () => {
    const res = await fetch(path, {
      credentials: 'include',
      signal,
    });
    if (!res.ok || !res.body) {
      const err = new Error(`SSE ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      // El gateway manda un latido cada 15 s. Si no llega nada en SILENCIO_MS
      // la conexión está muerta sin haberse cerrado (reinicio del gateway
      // detrás de un proxy, red que cambia): se suelta para que el llamador
      // reconecte desde su último seq en vez de esperar para siempre.
      let reloj;
      const silencio = new Promise((resolve) => { reloj = setTimeout(() => resolve({ mudo: true }), SILENCIO_MS); });
      const { done, value, mudo } = await Promise.race([reader.read(), silencio]).finally(() => clearTimeout(reloj));
      if (mudo) { reader.cancel().catch(() => {}); return; }
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data:')) continue;
        try {
          const obj = JSON.parse(line.slice(5).trim());
          if (obj && typeof obj === 'object') onEvent(obj);
        } catch { /* frame malformado */ }
      }
    }
  })();
}

export const initialRemoteState = {
  items: [],
  approvals: [],
  agentState: 'idle',
  activity: null, // 'compacting' mientras Claude Code compacta
  hostConnected: false,
  meta: null,
  files: null,
  orch: null,
  orchDiff: {},
  orchTerm: {},
  orchAgents: null,
  orchError: null,
  session: null,
  ended: false,
  lastSeq: 0,
  // Coding (sesiones en la nube): entorno, rama, PR, vista previa, paneles,
  // preguntas del agente y ventana de contexto.
  sandbox: null,
  branch: null,
  pr: null,
  preview: null,
  diff: null,
  tree: null,
  archivo: null, // contenido del archivo abierto en el panel Código
  commits: null, // commits de la rama (pestaña PRs)
  procs: [], // comandos en segundo plano del entorno
  choices: [],
  context: null,
  turnStart: null,
};

let nextKey = 1;
const withKey = (item) => ({ key: `r${nextKey++}`, ...item });

const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);

// Imagen que el agente enseñó con show_image (CLI 2.13).
const shownImage = (m) => withKey({
  kind: 'image', id: m.id || '', name: m.name || 'imagen', w: m.w || 0, h: m.h || 0, caption: m.caption || '',
});

function mapSnapshotMessages(messages) {
  const items = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'user') items.push(withKey({ kind: 'user', text: m.content || '', imageIds: ids(m.image_ids) }));
    else if (m.role === 'image' && m.id) items.push(shownImage(m));
    else if (m.role === 'assistant') items.push(withKey({ kind: 'assistant', text: m.content || '', open: false }));
    else if (m.role === 'tool') {
      items.push(withKey({
        kind: 'tool', id: m.id || '', tool: m.tool || 'tool', summary: m.summary || '', label: m.label || '',
        result: m.content || '', error: m.ok === false, running: !!m.pending,
      }));
    } else if (m.role === 'error') items.push(withKey({ kind: 'error', text: m.content || '' }));
  }
  return items;
}

const lastIdx = (items, pred) => {
  for (let i = items.length - 1; i >= 0; i--) if (pred(items[i])) return i;
  return -1;
};

// La duración del turno (assistant_done.ms) va en su última burbuja: Coding la
// enseña como «Trabajó 12s · 4 pasos».
function conDuracion(items, ms) {
  if (!ms) return items;
  const idx = lastIdx(items, (it) => it.kind === 'assistant');
  return idx === -1 ? items : items.map((it, i) => (i === idx ? { ...it, ms } : it));
}

function closeOpenAssistant(items, finalText) {
  const idx = lastIdx(items, (it) => it.kind === 'assistant' && it.open);
  if (idx === -1) return items;
  const text = typeof finalText === 'string' ? finalText : items[idx].text;
  if (!text.trim()) return [...items.slice(0, idx), ...items.slice(idx + 1)];
  return items.map((it, i) => (i === idx ? { ...it, text, open: false } : it));
}

const tsDe = (ev) => (typeof ev.ts === 'number' ? ev.ts * 1000 : Date.now());

export function remoteReducer(state, ev) {
  // Un seq que no es un entero seguro >= 0 (NaN, Infinity, negativo, texto…) ni se aplica ni envenena lastSeq (LXO-243).
  if (!hasValidSeq(ev)) return state;
  // Los dos canales que pueden reemplazar la snapshot del orquestador, con su pr_url saneada y el control de seq.
  // channel_status llega primero al reconectar con el seq más alto del canal: no avanza lastSeq, o el replay de lo perdido
  // se descartaría como duplicado (lo explica `reduceRemoteOrchEvent`).
  if (ev.type === 'channel_status' || ev.type === 'orch') return reduceRemoteOrchEvent(state, ev);
  if (typeof ev.seq === 'number' && ev.seq <= state.lastSeq) {
    return state;
  }
  const s = typeof ev.seq !== 'number' ? state : { ...state, lastSeq: ev.seq };

  switch (ev.type) {
    case 'orch_diff':
      return { ...s, orchDiff: { ...s.orchDiff, [ev.task]: ev } };
    case 'orch_term':
      return { ...s, orchTerm: { ...s.orchTerm, [ev.task]: ev } };
    case 'orch_agents':
      return { ...s, orchAgents: Array.isArray(ev.agents) ? ev.agents : [] };
    case 'orch_error':
      return { ...s, orchError: { message: ev.message || 'Error', action: ev.action, at: Date.now() } };
    case 'hello':
      return {
        ...s,
        meta: {
          source: ev.source, agent: ev.agent || null, title: ev.title, workspace: ev.workspace || null,
          machine: ev.machine, mode: ev.mode, model: ev.model,
          capabilities: Array.isArray(ev.capabilities) ? ev.capabilities : [],
          commands: Array.isArray(ev.commands) ? ev.commands : [],
          models: Array.isArray(ev.models) ? ev.models : [],
          model_value: ev.model_value ?? null,
          efforts: Array.isArray(ev.efforts) ? ev.efforts : [],
          effort: ev.effort ?? null,
          repo: ev.repo || null,
          branch: ev.branch || null,
          default_branch: ev.default_branch || null,
          // Límites del entorno: { turn_minutes, background_max }.
          limits: ev.limits && typeof ev.limits === 'object' ? ev.limits : null,
          espacio: ev.espacio || null,
        },
        branch: ev.branch || s.branch,
      };
    case 'files':
      return { ...s, files: { query: ev.query || '', items: Array.isArray(ev.items) ? ev.items : [] } };
    case 'notice':
      return { ...s, items: [...closeOpenAssistant(s.items), withKey({ kind: 'notice', text: ev.text || '' })] };
    case 'snapshot':
      return { ...s, items: mapSnapshotMessages(ev.messages) };
    case 'user_msg':
      return {
        ...s,
        turnLimit: null,
        turnStart: Date.now(),
        items: [...closeOpenAssistant(s.items), withKey({
          kind: 'user', text: ev.text || '', origin: ev.origin, images: ev.images || 0, imageIds: ids(ev.image_ids),
          mentions: ev.mentions || [],
        })],
      };
    case 'image_shown':
      return ev.id ? { ...s, items: [...closeOpenAssistant(s.items), shownImage(ev)] } : s;
    case 'assistant_delta': {
      const items = [...s.items];
      const idx = lastIdx(items, (it) => it.kind === 'assistant' && it.open);
      if (idx === -1) items.push(withKey({ kind: 'assistant', text: ev.text || '', open: true }));
      else items[idx] = { ...items[idx], text: items[idx].text + (ev.text || '') };
      return { ...s, items };
    }
    case 'assistant_replace': {
      const items = [...s.items];
      const idx = lastIdx(items, (it) => it.kind === 'assistant' && it.open);
      if (idx === -1) items.push(withKey({ kind: 'assistant', text: ev.text || '', open: true }));
      else items[idx] = { ...items[idx], text: ev.text || '' };
      return { ...s, items };
    }
    case 'assistant_done': {
      // Al releer una sesión guardada no hay deltas (no se persisten), así que
      // no existe burbuja abierta que cerrar: el turno se crea aquí, ya cerrado.
      const idx = lastIdx(s.items, (it) => it.kind === 'assistant' && it.open);
      if (idx === -1) {
        const text = ev.text || '';
        return text.trim()
          ? { ...s, items: [...s.items, withKey({ kind: 'assistant', text, open: false, ms: ev.ms || null })] }
          : s;
      }
      return { ...s, items: conDuracion(closeOpenAssistant(s.items, ev.text || ''), ev.ms) };
    }
    case 'tool_use':
      return {
        ...s,
        items: [...closeOpenAssistant(s.items), withKey({
          kind: 'tool', id: ev.id || '', tool: ev.tool || 'tool', summary: ev.summary || '', label: ev.label || '',
          readonly: !!ev.readonly, running: true, result: '', error: false,
        })],
      };
    case 'tool_result': {
      const items = [...s.items];
      const idx = ev.id
        ? lastIdx(items, (it) => it.kind === 'tool' && it.id === ev.id)
        : lastIdx(items, (it) => it.kind === 'tool' && it.running && it.tool === ev.tool);
      const patch = { running: false, result: ev.result || '', error: !!ev.error };
      if (idx === -1) items.push(withKey({ kind: 'tool', tool: ev.tool || 'tool', summary: '', ...patch }));
      else items[idx] = { ...items[idx], ...patch };
      return { ...s, items };
    }
    case 'status': {
      const thinking = ev.state === 'thinking';
      return {
        ...s,
        agentState: thinking ? 'thinking' : 'idle',
        activity: thinking ? ev.activity || null : null,
        activityLabel: thinking ? ev.label || null : null,
        turnStart: thinking ? (s.turnStart || Date.now()) : s.turnStart,
      };
    }
    // ── Coding (sesiones en la nube) ──
    case 'sandbox_status':
      return { ...s, sandbox: { estado: ev.estado, detalle: ev.detalle || null, motivo: ev.motivo || null } };
    case 'branch':
      return { ...s, branch: ev.name || s.branch };
    case 'pr': {
      const url = sanitizePrUrl(ev.url);
      if (!url) return s;
      const pr = { url, number: ev.number, branch: ev.branch, base: ev.base };
      return { ...s, pr, items: [...closeOpenAssistant(s.items), withKey({ kind: 'pr', ...pr })] };
    }
    case 'preview_shown':
      return { ...s, preview: { port: ev.port, path: ev.path || '/', n: (s.preview?.n || 0) + 1, ts: typeof ev.ts === 'number' ? ev.ts * 1000 : Date.now() } };
    case 'diff':
      return { ...s, diff: { files: Array.isArray(ev.files) ? ev.files : [], truncated: !!ev.truncated, base: ev.base, branch: ev.branch } };
    case 'tree':
      return { ...s, tree: { entries: Array.isArray(ev.entries) ? ev.entries : [], truncated: !!ev.truncated, branch: ev.branch } };
    case 'file_content':
      return { ...s, archivo: { path: ev.path, text: ev.text ?? null, binary: !!ev.binary, truncated: !!ev.truncated, error: ev.error || null } };
    case 'commits':
      return { ...s, commits: { items: Array.isArray(ev.items) ? ev.items : [], pushed: !!ev.pushed, branch: ev.branch, base: ev.base } };
    case 'procs':
      return { ...s, procs: Array.isArray(ev.items) ? ev.items : [],
        ...(Array.isArray(ev.ports) ? { ports: { items: ev.ports, ts: tsDe(ev) } } : {}) };
    // Puertos que escuchan en el entorno: [{ port, label?, command? }].
    case 'ports':
      return { ...s, ports: { items: Array.isArray(ev.items) ? ev.items : [], ts: tsDe(ev) } };
    // Preparación del repo tras clonar (instalar dependencias).
    case 'setup':
      return { ...s, setup: {
        estado: ev.estado, comando: ev.command || ev.comando || '', lockfile: ev.lockfile || '',
        ms: ev.ms || 0, pasos: Array.isArray(ev.steps) ? ev.steps : [], salida: ev.output || '', detalle: ev.detail || '',
        inicio: s.setup?.estado === 'instalando' ? s.setup.inicio : tsDe(ev),
      } };
    // El turno llegó a su límite de tiempo: el agente se detuvo.
    case 'turn_limit':
      return { ...s, turnLimit: { minutes: ev.minutes || null, detalle: ev.detail || '', n: (s.turnLimit?.n || 0) + 1 } };
    // Uso de la sesión entera: { tokens, seconds }.
    case 'usage':
      return { ...s, usage: { tokens: ev.tokens || 0, seconds: ev.seconds || 0 } };
    // El agente propone una nota para la memoria del espacio.
    case 'memory_proposal':
      if (!ev.id || (s.propuestas || []).some((x) => x.id === ev.id)) return s;
      return { ...s, propuestas: [...(s.propuestas || []), { id: ev.id, text: ev.text || '', espacio: ev.espacio || null }] };
    case 'context':
      return { ...s, context: { used: ev.tokens || 0, total: ev.window || null } };
    case 'choice_request':
      if (!ev.id || s.choices.some((c) => c.id === ev.id)) return s;
      return { ...s, choices: [...s.choices, { id: ev.id, title: ev.title || '', header: ev.header || '', options: Array.isArray(ev.options) ? ev.options : [], free: ev.free !== false }] };
    case 'choice_resolved':
      return { ...s, choices: s.choices.filter((c) => c.id !== ev.id) };
    case 'approval_request':
      if (s.approvals.some((a) => a.id === ev.id)) return s;
      return { ...s, approvals: [...s.approvals, {
        id: ev.id, tool: ev.tool, summary: ev.summary || '', risk: ev.risk || 'edit',
        path: ev.path || '', adds: ev.adds || 0, dels: ev.dels || 0,
      }] };
    case 'approval_resolved':
      return { ...s, approvals: s.approvals.filter((a) => a.id !== ev.id) };
    case 'error':
      return { ...s, items: [...s.items, withKey({ kind: 'error', text: ev.message || 'Error' })] };
    case 'bye':
    case 'session_ended':
      return { ...s, ended: true, hostConnected: false, approvals: [], choices: [] };
    default:
      return s;
  }
}
