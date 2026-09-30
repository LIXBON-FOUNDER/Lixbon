// CalendarioView.jsx — el ciclo, las fechas límite de las issues y el inicio y
// cierre de cada ciclo en una rejilla de semanas. Cada issue es una ficha con el
// cuadro del color de su estado; pinchar un día vacío crea una issue para ese día.
import { useState } from 'react';
import { useIssuesStore } from '../store/issuesStore';
import { useTablero } from '../store/useTablero';
import { TPanel } from '../ui/Panel';
import { IconCalendar } from '../ui/icons';
import { IconChevronLeft, IconChevronRight, IconPlus } from '../../components/Icons';
import { esCerrado, hoyISO, sumarDias, diaDe, isoDe, MESES_LARGOS, fechaCorta } from '../lib/issues';

const CABECERA = ['LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB', 'DOM'];
const lunesDe = (iso) => sumarDias(iso, -((diaDe(iso).getDay() + 6) % 7));

export function CalendarioView() {
  const t = useTablero();
  const abrir = useIssuesStore((s) => s.abrir);
  const abrirCreacion = useIssuesStore((s) => s.abrirCreacion);
  const hayCiclos = !!t.tablero.config?.ciclos?.activos && t.tablero.ciclos.length > 0;
  const [modo, setModo] = useState(hayCiclos ? 'ciclo' : 'mes');
  const [ancla, setAncla] = useState(hoyISO());
  const hoy = hoyISO();

  const cicloAncla = t.tablero.ciclos.find((c) => c.empieza <= ancla && ancla <= c.termina) || t.cicloHoy;
  let desde; let hasta; let titulo;
  if (modo === 'ciclo' && cicloAncla) {
    desde = lunesDe(cicloAncla.empieza);
    hasta = sumarDias(lunesDe(cicloAncla.termina), 6);
    titulo = `Ciclo ${cicloAncla.numero}`;
  } else {
    const d = diaDe(ancla);
    const primero = isoDe(new Date(d.getFullYear(), d.getMonth(), 1));
    const ultimo = isoDe(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    desde = lunesDe(primero);
    hasta = sumarDias(lunesDe(ultimo), 6);
    titulo = `${MESES_LARGOS[d.getMonth()][0].toUpperCase()}${MESES_LARGOS[d.getMonth()].slice(1)} ${d.getFullYear()}`;
  }
  const dias = [];
  for (let d = desde; d <= hasta; d = sumarDias(d, 1)) dias.push(d);
  const semanas = dias.length / 7;
  const mesAncla = diaDe(ancla).getMonth();

  const mover = (dir) => {
    if (modo === 'ciclo' && cicloAncla) {
      const i = t.tablero.ciclos.findIndex((c) => c.id === cicloAncla.id);
      const otro = t.tablero.ciclos[i + dir];
      if (otro) setAncla(otro.empieza);
      else setAncla(sumarDias(dir > 0 ? cicloAncla.termina : cicloAncla.empieza, dir));
    } else {
      const d = diaDe(ancla);
      setAncla(isoDe(new Date(d.getFullYear(), d.getMonth() + dir, 1)));
    }
  };

  const porDia = {};
  for (const i of t.issues) {
    if (i.fecha_limite && i.fecha_limite >= desde && i.fecha_limite <= hasta) (porDia[i.fecha_limite] ||= []).push(i);
  }
  const cicloDe = (d) => t.tablero.ciclos.find((c) => c.empieza <= d && d <= c.termina);

  return (
    <TPanel id="calendario" className="wb__grow tcal">
      <div className="tcabeza">
        <div className="tcabeza__fila">
          <span className="tcabeza__ico is-warn"><IconCalendar size={17} /></span>
          <h1 className="tcabeza__titulo">{titulo}</h1>
          {modo === 'ciclo' && cicloAncla && <span className="tdim">{fechaCorta(cicloAncla.empieza)} – {fechaCorta(cicloAncla.termina)}</span>}
          <span className="tfill" />
          <div className="tseg" role="group" aria-label="Rango">
            {hayCiclos && <button className={modo === 'ciclo' ? 'is-on' : ''} aria-pressed={modo === 'ciclo'} onClick={() => setModo('ciclo')}>Ciclo</button>}
            <button className={modo === 'mes' ? 'is-on' : ''} aria-pressed={modo === 'mes'} onClick={() => setModo('mes')}>Mes</button>
          </div>
          <div className="tcal__nav">
            <button className="tbtn" onClick={() => mover(-1)} aria-label="Anterior"><IconChevronLeft size={14} /></button>
            <button className="tbtn" onClick={() => setAncla(hoy)}>Hoy</button>
            <button className="tbtn" onClick={() => mover(1)} aria-label="Siguiente"><IconChevronRight size={14} /></button>
          </div>
        </div>
        <div className="tleyenda tcal__leyenda">
          <span><span className="tcal__muestra"><i /></span>Issue que vence (color de su estado)</span>
          {hayCiclos && <span><i className="is-linea" style={{ background: 'var(--accent)' }} />Ciclo</span>}
        </div>
      </div>

      <div className="tcal__rejilla" style={{ '--semanas': semanas }}>
        {CABECERA.map((d) => <span key={d} className="tcal__dia">{d}</span>)}
        {dias.map((d) => {
          const c = cicloDe(d);
          const fuera = modo === 'mes' ? diaDe(d).getMonth() !== mesAncla : !(cicloAncla && c?.id === cicloAncla.id);
          const eventos = porDia[d] || [];
          const nota = c && d === c.empieza ? `Empieza el ciclo ${c.numero}` : c && d === c.termina ? `Cierra el ciclo ${c.numero}` : d === hoy ? 'Hoy' : '';
          return (
            <div key={d} className={`tcal__celda ${fuera ? 'is-fuera' : ''} ${d === hoy ? 'is-hoy' : ''}`}>
              <div className="tcal__cab">
                <span className="tcal__num">{diaDe(d).getDate()}</span>
                <span className="tcal__nota">{nota}</span>
                <button className="ic tcal__mas" onClick={() => abrirCreacion({ proyectoId: t.proyectoId, fecha: d, sinAbrir: true })} aria-label={`Nueva issue para el ${fechaCorta(d)}`}><IconPlus size={12} /></button>
              </div>
              {hayCiclos && c && <span className={`tcal__banda ${d === c.empieza ? 'is-ini' : ''} ${d === c.termina ? 'is-fin' : ''}`} />}
              <div className="tcal__eventos">
                {eventos.slice(0, 3).map((i) => {
                  const e = t.estadosPorId[i.estado_id];
                  const tarde = !esCerrado(e) && d < hoy;
                  return (
                    <button key={i.id} className="tcal__ev" onClick={() => abrir(i.id)} title={`${i.clave} · ${i.titulo}`}>
                      <span className="tcuadro" style={{ background: e?.color }} />
                      <span className={`mono tcal__clave ${tarde ? 'is-tarde' : ''}`}>{i.clave}</span>
                      <span className="tcal__t">{i.titulo}</span>
                    </button>
                  );
                })}
                {eventos.length > 3 && <span className="tcal__mas2">+{eventos.length - 3} más</span>}
              </div>
            </div>
          );
        })}
      </div>
    </TPanel>
  );
}
