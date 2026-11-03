// Cómo se ve el agente mientras trabaja y cuando termina.
// - En curso: una sola línea (isotipo animado + frase de lo que hace ahora +
//   tiempo) y debajo, en fichas, lo que está tocando: archivos, ramas,
//   búsquedas. Se ve con qué trabaja sin leer nada.
// - Terminado: la línea se pliega en un resumen («Trabajó 12s · 4 pasos») que
//   se despliega para ver los pasos (cada uno ya dice qué tocó).
import { useEffect, useState } from 'react';
import { Icono } from './Icons';
import { LogoTrabajando } from './Logo';
import { ShimmerText } from './ShimmerText';
import { useT } from '../i18n/useT';

const MAX_FICHAS = 4;

/** 8s · 1m 05s */
export function duracion(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Icono de la ficha según la herramienta del paso. */
function iconoDe(nombre = '') {
  if (nombre === 'busqueda') return 'buscar';
  if (nombre === 'fuente') return 'globo';
  if (nombre.includes('search')) return 'buscar';
  if (nombre.includes('list_files') || nombre.includes('list_tree')) return 'carpeta';
  if (nombre.includes('file')) return 'archivo';
  if (nombre.includes('branch')) return 'bifurcar';
  if (nombre.includes('commit')) return 'commit';
  if (nombre.includes('pull_request')) return 'pull-request';
  if (nombre.includes('issue') || nombre.includes('comment')) return 'issues';
  return 'github';
}

/** Fichas únicas (por texto) a partir de los pasos y las búsquedas. */
export function fichasDe(pasos = [], queries = []) {
  const vistas = new Set();
  const fichas = [];
  for (const q of queries) {
    if (q && !vistas.has(q)) { vistas.add(q); fichas.push({ icono: 'buscar', texto: q }); }
  }
  for (const p of pasos) {
    const texto = (p.target || '').trim();
    if (texto && !vistas.has(texto)) { vistas.add(texto); fichas.push({ icono: iconoDe(p.name), texto }); }
  }
  return fichas;
}

function Fichas({ fichas }) {
  const t = useT('chat');
  if (!fichas.length) return null;
  const visibles = fichas.slice(0, MAX_FICHAS);
  const resto = fichas.length - visibles.length;
  return (
    <ul className="trabajo__fichas">
      {visibles.map((f) => (
        <li key={f.texto} className="trabajo__ficha" title={f.texto}>
          <Icono nombre={f.icono} size={13} />
          <span>{f.texto}</span>
        </li>
      ))}
      {resto > 0 && <li className="trabajo__ficha trabajo__ficha--mas">{t('workMore', { n: resto })}</li>}
    </ul>
  );
}

/** Reloj que avanza solo mientras la línea está en pantalla. */
function useAhora(activo) {
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    if (!activo) return undefined;
    const id = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(id);
  }, [activo]);
  return ahora;
}

/** En curso: frase + tiempo, y las fichas debajo. */
export function LineaTrabajo({ texto, inicio, fichas = [] }) {
  const ahora = useAhora(true);
  return (
    <div className="trabajo" role="status">
      <span className="msg__trabajo">
        <LogoTrabajando />
        <ShimmerText key={texto} text={texto} />
        {inicio ? <span className="trabajo__tiempo">{duracion(ahora - inicio)}</span> : null}
      </span>
      <Fichas fichas={fichas} />
    </div>
  );
}

/** Terminado: resumen plegado con los pasos dentro. */
export function ResumenTrabajo({ inicio, fin, pasos = [], textoPaso }) {
  const t = useT('chat');
  if (!pasos.length || !inicio || !fin) return null;
  const n = pasos.length;
  return (
    <details className="trabajo-resumen">
      <summary className="trabajo-resumen__linea">
        <span>{t('workedFor', { t: duracion(fin - inicio) })}</span>
        <span className="trabajo-resumen__dato">· {n === 1 ? t('workStep') : t('workSteps', { n })}</span>
      </summary>
      <ol className="trabajo-resumen__pasos">
        {pasos.map((p, i) => (
          <li key={i}>
            <Icono nombre={iconoDe(p.name)} size={14} />
            <span>{textoPaso(p)}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
