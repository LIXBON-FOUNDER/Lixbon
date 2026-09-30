// ProyectosView.jsx — Proyectos y ciclos: el avance del ciclo (cifras, gráfica
// de alcance frente a cerradas y carga por persona) y la tabla de proyectos con
// su responsable, su estado y su fecha objetivo.
import { useMemo, useState } from 'react';
import * as api from '../lib/api';
import { useTeamStore } from '../store/teamStore';
import { useIssuesStore } from '../store/issuesStore';
import { useTablero } from '../store/useTablero';
import { TPanel, Cara, nombreDe } from '../ui/Panel';
import { Barra, PuntoCuadrado } from '../ui/Marcas';
import { Desplegable, Opciones } from '../ui/Menu';
import { IconCapas } from '../ui/icons';
import { IconPlus, IconChevronLeft, IconChevronRight, IconTrash } from '../../components/Icons';
import {
  avance, serieDelCiclo, fechaCorta, diasEntre, hoyISO, ESTADOS_INICIATIVA, COLORES, vencimiento,
} from '../lib/issues';

function Grafica({ ciclo, serie }) {
  const [sobre, setSobre] = useState(null);
  if (!ciclo || !serie.length) return <p className="tnota">La gráfica aparece en cuanto el ciclo tenga issues.</p>;
  const W = 640; const H = 210; const IZQ = 36; const DER = 600; const ARR = 14; const ABA = 188;
  const dias = diasEntre(ciclo.empieza, ciclo.termina) + 1;
  const tope = Math.max(4, ...serie.map((p) => p.alcance));
  const paso = Math.ceil(tope / 4);
  const max = paso * 4;
  const x = (n) => IZQ + (n * (DER - IZQ)) / Math.max(1, dias - 1);
  const y = (v) => ABA - (v * (ABA - ARR)) / max;
  const linea = (k) => serie.map((p, n) => `${x(n).toFixed(1)},${y(p[k]).toFixed(1)}`).join(' ');
  const ult = serie.length - 1;
  const area = `${linea('cerradas')} ${x(ult).toFixed(1)},${y(0)} ${x(0)},${y(0)}`;
  const p = sobre != null ? serie[sobre] : null;
  // Etiquetas junto al último punto, sin pisar el «Hoy» de arriba ni el eje de abajo.
  const yA = y(serie[ult].alcance);
  const yC = y(serie[ult].cerradas);
  const yLblAlcance = yA - 8 < ARR + 22 ? yA + 16 : yA - 8;
  const yLblCerradas = Math.min(ABA - 6, Math.max(yC + 16, yLblAlcance + 16));
  return (
    <div className="tgrafica">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Alcance ${serie[ult].alcance} issues, cerradas ${serie[ult].cerradas}, al ${fechaCorta(serie[ult].dia)}`}
        onPointerLeave={() => setSobre(null)}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const n = Math.round(((px - IZQ) / (DER - IZQ)) * (dias - 1));
          setSobre(n >= 0 && n <= ult ? n : null);
        }}>
        {[0, 1, 2, 3, 4].map((k) => (
          <g key={k}>
            <line x1={IZQ} x2={DER} y1={y(k * paso)} y2={y(k * paso)} className="tgrafica__rej" />
            <text x={IZQ - 8} y={y(k * paso) + 4} textAnchor="end" className="tgrafica__eje">{k * paso}</text>
          </g>
        ))}
        <text x={IZQ} y={H - 2} textAnchor="middle" className="tgrafica__eje">{fechaCorta(ciclo.empieza)}</text>
        <text x={DER} y={H - 2} textAnchor="middle" className="tgrafica__eje">{fechaCorta(ciclo.termina)}</text>
        {ult > 0 && ult < dias - 1 && (
          <>
            <line x1={x(ult)} x2={x(ult)} y1={ARR} y2={ABA} className="tgrafica__hoy" />
            <text x={x(ult) - 6} y={ARR + 4} textAnchor="end" className="tgrafica__eje">Hoy</text>
          </>
        )}
        <polygon points={area} className="tgrafica__area" />
        <polyline points={linea('alcance')} className="tgrafica__alcance" />
        <polyline points={linea('cerradas')} className="tgrafica__cerradas" />
        <circle cx={x(ult)} cy={y(serie[ult].alcance)} r="4" className="tgrafica__pt is-alcance" />
        <circle cx={x(ult)} cy={y(serie[ult].cerradas)} r="4" className="tgrafica__pt is-cerradas" />
        <text x={Math.min(x(ult) + 10, DER - 70)} y={yLblAlcance} className="tgrafica__lbl">Alcance {serie[ult].alcance}</text>
        <text x={Math.min(x(ult) + 10, DER - 70)} y={yLblCerradas} className="tgrafica__lbl">Cerradas {serie[ult].cerradas}</text>
        {p && (
          <>
            <line x1={x(sobre)} x2={x(sobre)} y1={ARR} y2={ABA} className="tgrafica__cruz" />
            <circle cx={x(sobre)} cy={y(p.alcance)} r="4" className="tgrafica__pt is-alcance" />
            <circle cx={x(sobre)} cy={y(p.cerradas)} r="4" className="tgrafica__pt is-cerradas" />
          </>
        )}
      </svg>
      {p && (
        <div className="tgrafica__tip" style={{ left: `${(x(sobre) / W) * 100}%` }}>
          <b>{fechaCorta(p.dia)}</b><span>Alcance {p.alcance}</span><span>Cerradas {p.cerradas}</span>
        </div>
      )}
    </div>
  );
}

function FormIniciativa({ t, inicial, onCerrar }) {
  const [d, setD] = useState(inicial || { nombre: '', color: COLORES[1], responsable_id: t.usuario?.id ?? null, objetivo: '', estado: 'planificado' });
  const [error, setError] = useState('');
  const guardar = async (e) => {
    e.preventDefault();
    if (!d.nombre.trim()) return;
    const datos = { ...d, nombre: d.nombre.trim(), objetivo: d.objetivo || null };
    try {
      if (inicial?.id) await api.editarIniciativa(inicial.id, datos);
      else await api.crearIniciativa(t.proyectoId, datos);
      onCerrar();
    } catch (err) { setError(err.message); }
  };
  return (
    <form className="tformini" onSubmit={guardar}>
      <input className="tinput" autoFocus value={d.nombre} onChange={(e) => setD({ ...d, nombre: e.target.value })} placeholder="Nombre del proyecto" maxLength={60} aria-label="Nombre del proyecto" />
      <span className="tcolores">
        {COLORES.slice(0, 6).map((c) => <button key={c} type="button" className={`tcolores__c ${c === d.color ? 'is-on' : ''}`} style={{ background: c }} onClick={() => setD({ ...d, color: c })} aria-label={`Color ${c}`} />)}
      </span>
      <select className="tinput" value={d.responsable_id ?? ''} onChange={(e) => setD({ ...d, responsable_id: e.target.value ? Number(e.target.value) : null })} aria-label="Responsable">
        <option value="">Sin responsable</option>
        {t.miembros.map((m) => <option key={m.usuario.id} value={m.usuario.id}>{nombreDe(m.usuario)}</option>)}
      </select>
      <input className="tinput" type="date" value={d.objetivo || ''} onChange={(e) => setD({ ...d, objetivo: e.target.value })} aria-label="Fecha objetivo" />
      <select className="tinput" value={d.estado} onChange={(e) => setD({ ...d, estado: e.target.value })} aria-label="Estado">
        {Object.entries(ESTADOS_INICIATIVA).map(([k, v]) => <option key={k} value={k}>{v.nombre}</option>)}
      </select>
      <button className="btn btn--primary btn--sm" type="submit" disabled={!d.nombre.trim()}>{inicial?.id ? 'Guardar' : 'Crear'}</button>
      <button className="btn btn--ghost btn--sm" type="button" onClick={onCerrar}>Cancelar</button>
      {error && <span className="terror">{error}</span>}
    </form>
  );
}

function IconoEstadoIni({ estado }) {
  if (estado === 'en_riesgo') return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l9.5 17h-19z" /><path d="M12 10v4M12 17h.01" /></svg>;
  if (estado === 'planificado') return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="3.5" width="17" height="17" rx="5" /><path d="M8 12l3 3 5-6" /></svg>;
}

export function ProyectosView() {
  const t = useTablero();
  const irA = useTeamStore((s) => s.irA);
  const abrirCreacion = useIssuesStore((s) => s.abrirCreacion);
  const ciclos = t.tablero.ciclos;
  const [cicloId, setCicloId] = useState(null);
  const [form, setForm] = useState(null);   // null | 'nuevo' | iniciativa
  const ciclo = ciclos.find((c) => c.id === cicloId) || t.cicloHoy || ciclos[ciclos.length - 1] || null;
  const idx = ciclo ? ciclos.findIndex((c) => c.id === ciclo.id) : -1;

  const delCiclo = useMemo(() => (ciclo ? t.issues.filter((i) => i.ciclo_id === ciclo.id) : []), [ciclo, t.issues]);
  const av = avance(delCiclo, t.estadosPorId);
  const serie = useMemo(() => serieDelCiclo(ciclo, delCiclo), [ciclo, delCiclo]);
  const anadidas = ciclo ? delCiclo.filter((i) => i.creado_en.slice(0, 10) > ciclo.empieza).length : 0;
  const hoy = hoyISO();
  const quedan = ciclo ? Math.max(0, diasEntre(hoy, ciclo.termina)) : 0;

  const carga = t.miembros.map((m) => {
    const suyas = delCiclo.filter((i) => i.asignado_id === m.usuario.id);
    const total = suyas.reduce((n, i) => n + (i.estimacion || 0), 0);
    const hechos = suyas.filter((i) => t.estadosPorId[i.estado_id]?.tipo === 'hecho').reduce((n, i) => n + (i.estimacion || 0), 0);
    return { m, total, hechos, n: suyas.length };
  }).filter((c) => c.n > 0).sort((a, b) => b.total - a.total || b.n - a.n);
  const maxCarga = Math.max(1, ...carga.map((c) => c.total));

  return (
    <TPanel id="proyectos" className="wb__grow tproyv">
      <div className="tcabeza">
        <div className="tcabeza__fila">
          <span className="tcabeza__ico is-info"><IconCapas size={17} /></span>
          <h1 className="tcabeza__titulo">Proyectos y ciclos</h1>
          <span className="tfill" />
          {ciclos.length > 0 && (
            <div className="tseg" role="group" aria-label="Ciclo">
              <button disabled={idx <= 0} onClick={() => setCicloId(ciclos[idx - 1].id)} aria-label="Ciclo anterior"><IconChevronLeft size={13} /></button>
              <button className="is-on" aria-pressed="true">Ciclo {ciclo?.numero}</button>
              <button disabled={idx >= ciclos.length - 1} onClick={() => setCicloId(ciclos[idx + 1].id)} aria-label="Ciclo siguiente"><IconChevronRight size={13} /></button>
            </div>
          )}
          <button className="btn btn--acento" onClick={() => setForm('nuevo')}><IconPlus size={14} /> Nuevo proyecto</button>
        </div>
        <p className="tcabeza__sub">
          {ciclo ? `Ciclo ${ciclo.numero} · ${fechaCorta(ciclo.empieza)} – ${fechaCorta(ciclo.termina)}${ciclo.id === t.cicloHoy?.id ? ` · día ${diasEntre(ciclo.empieza, hoy) + 1} de ${diasEntre(ciclo.empieza, ciclo.termina) + 1}` : ''}` : 'Este equipo no trabaja por ciclos'}
          {` · ${t.tablero.iniciativas.length} ${t.tablero.iniciativas.length === 1 ? 'proyecto' : 'proyectos'}`}
        </p>
      </div>

      <div className="tproyv__scroll">
        {ciclo && (
          <div className="tproyv__fila">
            <section className="tbloquei tproyv__ciclo" aria-label={`Avance del ciclo ${ciclo.numero}`}>
              <div className="tcifras">
                <div className="tcifra"><span>Issues cerradas</span><b>{av.cerradas}<small> de {av.total}</small></b></div>
                <div className="tcifra"><span>Puntos hechos</span><b>{av.puntosHechos}<small> de {av.puntos}</small></b></div>
                <div className="tcifra"><span>Alcance añadido</span><b>+{anadidas}<small> issues</small></b></div>
                <div className="tcifra"><span>{ciclo.termina < hoy ? 'Terminó' : 'Quedan'}</span><b>{ciclo.termina < hoy ? fechaCorta(ciclo.termina) : quedan}<small>{ciclo.termina < hoy ? '' : quedan === 1 ? ' día' : ' días'}</small></b></div>
              </div>
              <div className="tbloquei__cab">
                <h2>Avance del ciclo</h2><span className="tfill" />
                <span className="tleyenda"><span><i className="is-linea" style={{ background: 'var(--ink-50)' }} />Alcance</span><span><i className="is-linea" style={{ background: 'var(--accent)' }} />Cerradas</span></span>
              </div>
              <Grafica ciclo={ciclo} serie={serie} />
            </section>

            <section className="tbloquei tproyv__carga" aria-label="Carga por persona">
              <div className="tbloquei__cab">
                <h2>Carga por persona</h2><span className="tfill" />
                <span className="tleyenda"><span><i style={{ background: 'var(--accent)' }} />Hechos</span><span><i style={{ background: 'var(--surface-6)' }} />Pendientes</span></span>
              </div>
              {carga.map(({ m, total, hechos, n }) => (
                <div key={m.usuario.id} className="tcarga">
                  <div className="tcarga__cab">
                    <Cara usuario={m.usuario} size={22} /><span>{nombreDe(m.usuario)}</span><span className="tfill" />
                    <span className="tdim">{total ? <><b>{hechos}</b> de {total} pts</> : `${n} ${n === 1 ? 'issue' : 'issues'} sin estimar`}</span>
                  </div>
                  {total > 0 && (
                    <div className="tcarga__barra">
                      <span style={{ width: `${(hechos / maxCarga) * 100}%`, background: 'var(--accent)' }} />
                      <span style={{ width: `${((total - hechos) / maxCarga) * 100}%`, background: 'var(--surface-6)' }} />
                    </div>
                  )}
                </div>
              ))}
              {!carga.length && <p className="tnota">Nadie tiene issues asignadas en este ciclo.</p>}
              <span className="tfill" />
              <p className="tnota tcarga__nota">Los agentes del orquestador no cuentan como persona: su trabajo suma a quien tiene asignada la issue.</p>
            </section>
          </div>
        )}

        <section className="tbloquei tproyv__tabla" aria-label="Proyectos">
          <div className="tproyt tproyt--cab" aria-hidden="true"><span>Proyecto</span><span>Avance</span><span>Estado</span><span>Responsable</span><span>Issues</span><span>Objetivo</span><span /></div>
          {form === 'nuevo' && <FormIniciativa t={t} onCerrar={() => setForm(null)} />}
          {t.tablero.iniciativas.map((x) => {
            if (form?.id === x.id) return <FormIniciativa key={x.id} t={t} inicial={form} onCerrar={() => setForm(null)} />;
            const suyas = t.issues.filter((i) => i.iniciativa_id === x.id);
            const a = avance(suyas, t.estadosPorId);
            const est = ESTADOS_INICIATIVA[x.estado] || ESTADOS_INICIATIVA.planificado;
            const r = t.gente[x.responsable_id];
            const v = vencimiento(x.objetivo, x.estado === 'hecho');
            return (
              <div key={x.id} className="tproyt">
                <button className="tproyt__nombre" onClick={() => setForm({ ...x, objetivo: x.objetivo || '' })}><PuntoCuadrado color={x.color} size={10} /><b>{x.nombre}</b></button>
                <span className="tproyt__av"><Barra pct={a.pct} color={x.color} ancho="100%" alto={6} /><span className="mono">{a.pct}%</span></span>
                <Desplegable ancho={180} boton={({ alternar }) => (
                  <button className="tproyt__estado" style={{ color: est.color }} onClick={alternar}><IconoEstadoIni estado={x.estado} />{est.nombre}</button>
                )}>
                  {(cerrar) => <Opciones cerrar={cerrar} valor={x.estado} onElegir={(v2) => api.editarIniciativa(x.id, { estado: v2 })}
                    opciones={Object.entries(ESTADOS_INICIATIVA).map(([k, e]) => ({ valor: k, nombre: e.nombre }))} />}
                </Desplegable>
                <span className="tproyt__resp">{r ? <><Cara usuario={r.usuario} size={20} />{nombreDe(r.usuario)}</> : <span className="tdim">—</span>}</span>
                <span className="tdim">{a.cerradas} de {a.total}</span>
                <span className={`tvence is-${v?.tono || 'normal'}`}>{v ? v.texto : '—'}</span>
                <span className="tproyt__acc">
                  <button className="ic" onClick={() => abrirCreacion({ proyectoId: t.proyectoId, iniciativaId: x.id })} aria-label={`Nueva issue en ${x.nombre}`}><IconPlus size={14} /></button>
                  {t.lider && <button className="ic" onClick={() => api.borrarIniciativa(x.id)} aria-label={`Borrar ${x.nombre}`}><IconTrash size={14} /></button>}
                </span>
              </div>
            );
          })}
          {!t.tablero.iniciativas.length && form !== 'nuevo' && (
            <p className="tnota tproyt__vacio">Un proyecto agrupa issues con un responsable y una fecha objetivo, como «Build de macOS». <button className="tlink" onClick={() => setForm('nuevo')}>Crear el primero</button> o <button className="tlink" onClick={() => irA('issues')}>ir a las issues</button>.</p>
          )}
        </section>
      </div>
    </TPanel>
  );
}
