// ObraAgente.jsx — la mascota cuando este chat coordina un equipo (/orquestar).
// Gael y Leya salen a la vez con casco de obra blanco: son el coordinador.
// Cada agente hijo es un robot obrero (color y casco según su rol) que llega
// caminando, recibe su tarea (un papel que vuela desde uno de los dos),
// trabaja de fondo, y al terminar camina hasta ellos con el informe.
// Todo se deduce del snapshot del orquestador; aquí solo se pone en escena.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useChatStore } from '../store/chatStore';
import { useAppStore } from '../store/appStore';
import { useOrchStore, isFinal } from '../store/orchStore';
import { useMascota } from '../lib/mascota';
import { SpriteMascota } from '../components/Mascota';

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const enRepo = (task, root) => {
  if (!task || !root) return false;
  const a = norm(task.repo);
  const b = norm(root);
  return a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);
};
const recorta = (t, n = 38) => (t && t.length > n ? `${t.slice(0, n - 1)}…` : t || 'una tarea');
const FUERA = 'calc(100% + 90px)';
// Los sprites existen por rol (bot-<rol>-*.png); lo demás va en gris.
const ROLES = ['explorador', 'implementador', 'revisor', 'escalado'];
const rolDe = (t) => (ROLES.includes(t.role) ? t.role : 'general');

function useRunActivo() {
  const snap = useOrchStore((s) => s.snap);
  const root = useAppStore((s) => s.workspaceRoot);
  return useMemo(() => {
    if (!snap?.settings?.enabled) return null;
    const vivos = Object.values(snap.runs || {})
      .filter((r) => { const t = snap.tasks?.[r.root]; return t && !isFinal(t.status) && enRepo(t, root); })
      .sort((a, b) => b.created - a.created);
    return vivos[0] || null;
  }, [snap, root]);
}

/** Hay un run en marcha en esta carpeta, o se acaba de mandar /orquestar y el
    coordinador aún está montando el equipo. */
export function useModoObra() {
  const run = useRunActivo();
  const planeando = useChatStore((s) => {
    if (!s.streaming) return false;
    const ultimo = [...(s.messages || [])].reverse().find((m) => m.role === 'user');
    return /^\/orquestar\b/i.test(String(ultimo?.content || '').trim());
  });
  return Boolean(run) || planeando;
}

function Globo({ texto, lado }) {
  if (!texto) return null;
  return <span className={`obra-globo ${lado === 'der' ? 'obra-globo--der' : ''}`} role="status">{texto}</span>;
}

export function ObraAgente({ tam = 96 }) {
  const prefs = useMascota();
  const snap = useOrchStore((s) => s.snap);
  const run = useRunActivo();
  const trabajando = useChatStore((s) => s.streaming);
  const [bots, setBots] = useState([]);
  const [papeles, setPapeles] = useState([]);
  const [actos, setActos] = useState({});
  const [globos, setGlobos] = useState({});
  const timers = useRef(new Set());
  const visto = useRef({ run: null, tareas: new Set(), msgs: new Set() });
  const cuenta = useRef({ encargos: 0, papeles: 0 });
  const botTam = tam >= 96 ? 72 : 48;
  const max = tam >= 96 ? 6 : 3;
  const paso = Math.round(botTam * 0.72);
  const pasoCoord = Math.round(tam * 0.8);
  const margen = tam >= 96 ? 18 : 12;
  const zona = margen + pasoCoord + tam;
  const derechaCoord = { gael: margen, leya: margen + pasoCoord };

  const en = (ms, fn) => {
    const t = setTimeout(() => { timers.current.delete(t); fn(); }, ms);
    timers.current.add(t);
  };
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const poner = (id, patch) => setBots((l) => l.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const quitar = (id) => setBots((l) => l.filter((b) => b.id !== id));
  const acto = (quien, estado, ms) => {
    setActos((a) => ({ ...a, [quien]: estado }));
    en(ms, () => setActos((a) => ({ ...a, [quien]: null })));
  };
  const decir = (id, texto, ms = 2600) => {
    setGlobos((g) => ({ ...g, [id]: texto }));
    en(ms, () => setGlobos((g) => (g[id] === texto ? { ...g, [id]: '' } : g)));
  };
  const volar = (de, a, tipo, bot) => {
    const id = ++cuenta.current.papeles;
    setPapeles((l) => [...l, { id, de, a, tipo, bot }]);
    en(1000, () => setPapeles((l) => l.filter((p) => p.id !== id)));
  };

  const llegar = (t) => {
    const quien = cuenta.current.encargos++ % 2 ? 'leya' : 'gael';
    setBots((l) => [...l, { id: t.id, rol: rolDe(t), fase: 'entra', quien, entrando: true }]);
    en(40, () => poner(t.id, { entrando: false }));
    en(900, () => { acto(quien, 'point', 1900); decir(quien, `Para ti: ${recorta(t.title)}`, 2800); });
    en(1500, () => {
      poner(t.id, { fase: 'recibe' });
      volar(derechaCoord[quien] + tam / 2 - 8, null, 'tarea', t.id);
    });
    en(2500, () => poner(t.id, { fase: 'trabaja' }));
  };

  const entregar = (b) => {
    const receptor = b.quien === 'gael' ? 'leya' : 'gael';
    poner(b.id, { fase: 'informa' });
    en(1900, () => {
      poner(b.id, { fase: 'entrega' });
      acto(receptor, 'wave', 1500);
      decir(receptor, 'Recibido, gracias.', 2200);
      volar(null, derechaCoord[receptor] + tam / 2 - 8, 'informe', b.id);
    });
    en(3400, () => poner(b.id, { fase: 'celebra' }));
    en(4500, () => poner(b.id, { fase: 'sale', entrando: true }));
    en(6300, () => quitar(b.id));
  };

  const fallar = (b) => {
    poner(b.id, { fase: 'cae' });
    decir(b.id, '¡Algo ha salido mal!', 2800);
    acto(b.quien, 'think', 2800);
    en(3000, () => poner(b.id, { fase: 'sale', entrando: true }));
    en(4800, () => quitar(b.id));
  };

  useEffect(() => {
    if (!snap || !run) { visto.current = { run: null, tareas: new Set(), msgs: new Set() }; setBots([]); return; }
    const tareas = Object.values(snap.tasks || {}).filter((t) => t.run === run.id && t.id !== run.root);
    const ids = new Set(tareas.map((t) => t.id));
    const mensajes = (snap.messages || []).filter((m) => ids.has(m.from) || ids.has(m.to));
    const v = visto.current;
    // Primera lectura del run: se colocan los que ya trabajan, sin repetir lo pasado.
    if (v.run !== run.id) {
      cuenta.current.encargos = 0;
      visto.current = { run: run.id, tareas: new Set(tareas.map((t) => t.id)), msgs: new Set(mensajes.map((m) => m.id)) };
      setBots(tareas.filter((t) => !isFinal(t.status)).slice(0, 12).map((t, i) => (
        { id: t.id, rol: rolDe(t), fase: t.status === 'waiting' ? 'duda' : 'trabaja', quien: i % 2 ? 'leya' : 'gael' }
      )));
      return;
    }
    const actuales = new Map(bots.map((b) => [b.id, b]));
    for (const t of tareas) {
      const b = actuales.get(t.id);
      if (!b && !v.tareas.has(t.id) && !isFinal(t.status)) { v.tareas.add(t.id); llegar(t); continue; }
      if (!b) continue;
      const enCurso = b.fase === 'trabaja' || b.fase === 'duda' || b.fase === 'recibe' || b.fase === 'entra';
      if (enCurso && t.status === 'done') entregar(b);
      else if (enCurso && (t.status === 'failed' || t.status === 'exited' || t.status === 'stopped')) fallar(b);
      else if (b.fase === 'trabaja' && t.status === 'waiting') { poner(b.id, { fase: 'duda' }); decir(b.id, '¿Me aclaras algo?'); }
      else if (b.fase === 'duda' && t.status === 'running') {
        poner(b.id, { fase: 'trabaja' });
        acto(b.quien, 'talk', 1500);
        volar(derechaCoord[b.quien] + tam / 2 - 8, null, 'tarea', b.id);
      }
    }
    for (const m of mensajes) {
      if (v.msgs.has(m.id)) continue;
      v.msgs.add(m.id);
      if (m.kind === 'phase' && actuales.get(m.from)) decir(m.from, recorta(m.body, 34), 2400);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap, run]);

  if (!prefs.activa) return null;
  const quieta = prefs.reducir;

  const visibles = bots.slice(0, max);
  const objetivo = zona - Math.round(botTam * 0.45);
  let slot = 0;
  const posiciones = visibles.map((b) => {
    if (b.entrando) return FUERA;
    if (b.fase === 'informa' || b.fase === 'entrega' || b.fase === 'celebra') return objetivo;
    return zona + 8 + slot++ * paso;
  });
  const centroBot = (id) => {
    const i = visibles.findIndex((b) => b.id === id);
    const pos = i < 0 || typeof posiciones[i] !== 'number' ? zona + 8 : posiciones[i];
    return pos + botTam / 2 - 8;
  };

  const base = (quien) => (trabajando ? (quien === 'gael' ? 'think' : 'type') : 'idle');
  const estadoBot = { entra: 'walk', recibe: 'idle', trabaja: 'work', duda: 'ask', cae: 'ask', informa: 'carry', entrega: 'idle', celebra: 'celebrate', sale: 'walk' };

  return (
    <div
      className={`obra ${tam < 96 ? 'obra--chica' : ''}`}
      style={{ '--tam': `${tam}px`, '--bot': `${botTam}px` }}
      role="status"
      aria-label={`Gael y Leya coordinan a ${bots.length} agente${bots.length === 1 ? '' : 's'}`}
    >
      {visibles.map((b, i) => (
        <div key={b.id} className={`obra-bot obra-bot--${b.fase}`} style={{ right: posiciones[i] }}>
          <Globo texto={globos[b.id]} />
          <SpriteMascota
            personaje={`bot-${b.rol}`}
            estado={estadoBot[b.fase] || 'idle'}
            tam={botTam}
            espejo={b.fase === 'sale'}
            quieta={quieta}
          />
        </div>
      ))}
      {papeles.map((p) => (
        <span
          key={p.id}
          className={`obra-papel obra-papel--${p.tipo}`}
          style={{ '--de': `${p.de ?? centroBot(p.bot)}px`, '--a': `${p.a ?? centroBot(p.bot)}px`, '--alto': `${Math.round(tam * 0.45)}px` }}
        ><i /></span>
      ))}
      {['leya', 'gael'].map((quien) => (
        <div key={quien} className="obra-coord" style={{ right: derechaCoord[quien] }}>
          <Globo texto={globos[quien]} lado="der" />
          <SpriteMascota personaje={quien} estado={actos[quien] || base(quien)} tam={tam} casco quieta={quieta} />
        </div>
      ))}
    </div>
  );
}
