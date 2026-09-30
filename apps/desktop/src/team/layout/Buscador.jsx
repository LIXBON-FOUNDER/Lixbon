// Buscador.jsx — Ctrl K: busca issues, canales y gente de todos tus equipos y
// abre lo elegido. Flechas para moverse, Enter para abrir.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTeamStore } from '../store/teamStore';
import { useIssuesStore } from '../store/issuesStore';
import { Casilla } from '../ui/Marcas';
import { Cara, nombreDe } from '../ui/Panel';
import { IconHash } from '../ui/icons';
import { IconSearch } from '../../components/Icons';
import { plano } from '../lib/issues';

export function Buscador() {
  const { proyectos, abrirCanal, abrirDirecto, usuario } = useTeamStore();
  const porProyecto = useIssuesStore((s) => s.porProyecto);
  const abrirIssue = useIssuesStore((s) => s.abrir);
  const [abierto, setAbierto] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const ref = useRef(null);

  useEffect(() => {
    const tecla = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setAbierto(true); }
    };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, []);
  useEffect(() => {
    if (!abierto) return undefined;
    const fuera = (e) => { if (!ref.current?.contains(e.target)) setAbierto(false); };
    window.addEventListener('pointerdown', fuera);
    return () => window.removeEventListener('pointerdown', fuera);
  }, [abierto]);
  useEffect(() => { setSel(0); }, [q]);

  const resultados = useMemo(() => {
    const p = plano(q.trim());
    if (!p) return [];
    const salida = [];
    for (const proy of proyectos) {
      const est = Object.fromEntries((proy.tablero?.estados || []).map((e) => [e.id, e]));
      for (const i of porProyecto[proy.id]?.issues || []) {
        if (plano(`${i.clave} ${i.titulo}`).includes(p)) {
          salida.push({ id: `i${i.id}`, tipo: 'Issue', icono: <Casilla estado={est[i.estado_id]} size={15} />, clave: i.clave, nombre: i.titulo, ir: () => abrirIssue(i.id) });
        }
      }
      for (const c of proy.canales) {
        if (plano(c.nombre).includes(p)) salida.push({ id: `c${c.id}`, tipo: proy.nombre, icono: <IconHash size={14} />, nombre: c.nombre, ir: () => abrirCanal(c.id) });
      }
    }
    const vistos = new Set();
    for (const proy of proyectos) {
      for (const m of proy.miembros) {
        if (m.usuario.id === usuario?.id || vistos.has(m.usuario.id)) continue;
        const n = [m.usuario.first_name, m.usuario.last_name, m.usuario.username].filter(Boolean).join(' ');
        if (plano(n).includes(p)) {
          vistos.add(m.usuario.id);
          salida.push({ id: `u${m.usuario.id}`, tipo: 'Persona', icono: <Cara usuario={m.usuario} size={18} />, nombre: nombreDe(m.usuario), ir: () => abrirDirecto(m.usuario.id) });
        }
      }
    }
    return salida.slice(0, 12);
  }, [q, proyectos, porProyecto, usuario, abrirIssue, abrirCanal, abrirDirecto]);

  const ir = (r) => { r.ir(); setAbierto(false); setQ(''); };

  return (
    <div className="tbuscador" ref={ref}>
      {!abierto ? (
        <button className="tbuscador__btn" onClick={() => setAbierto(true)}>
          <IconSearch size={13} />
          <span>Buscar issues, canales, gente…</span>
          <kbd>Ctrl K</kbd>
        </button>
      ) : (
        <div className="tbuscador__caja">
          <label className="tbuscador__campo">
            <IconSearch size={13} />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="LXB-12, un título, #canal o una persona"
              aria-label="Buscar en Lixbon Team"
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setAbierto(false); setQ(''); }
                if (e.key === 'ArrowDown') { e.preventDefault(); setSel((n) => Math.min(n + 1, resultados.length - 1)); }
                if (e.key === 'ArrowUp') { e.preventDefault(); setSel((n) => Math.max(n - 1, 0)); }
                if (e.key === 'Enter' && resultados[sel]) ir(resultados[sel]);
              }}
            />
          </label>
          {q.trim() && (
            <div className="tbuscador__res" role="listbox">
              {resultados.map((r, n) => (
                <button key={r.id} role="option" aria-selected={n === sel} className={`tmenu__item ${n === sel ? 'is-on' : ''}`} onMouseEnter={() => setSel(n)} onClick={() => ir(r)}>
                  {r.icono}
                  {r.clave && <span className="mono tdim">{r.clave}</span>}
                  <span className="tmenu__txt"><span>{r.nombre}</span></span>
                  <span className="tmenu__ayuda">{r.tipo}</span>
                </button>
              ))}
              {!resultados.length && <p className="tdesp__vacio">Nada con «{q.trim()}».</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
