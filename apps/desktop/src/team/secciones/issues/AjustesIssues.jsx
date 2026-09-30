// AjustesIssues.jsx — Ajustes del equipo › Issues: lo mismo que se eligió en el
// asistente al crear el equipo (identificador, estados, etiquetas, ritmo y
// automatismos con el IDE), editable después. Lo cambia el líder.
import { useEffect, useState } from 'react';
import * as api from '../../lib/api';
import { useTablero } from '../../store/useTablero';
import { Casilla, PuntoCuadrado } from '../../ui/Marcas';
import { IconTrash, IconPlus } from '../../../components/Icons';
import { COLORES, GRUPOS_ESTADO, DIAS } from '../../lib/issues';

function Interruptor({ on, onCambio, etiqueta, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={etiqueta} disabled={disabled}
      className={`tswitch ${on ? 'is-on' : ''}`} onClick={() => onCambio(!on)}>
      <span />
    </button>
  );
}

function Colores({ valor, onCambio, disabled }) {
  return (
    <span className="tcolores">
      {COLORES.map((c) => (
        <button key={c} type="button" disabled={disabled} className={`tcolores__c ${c === valor ? 'is-on' : ''}`} style={{ background: c }}
          onClick={() => onCambio(c)} aria-label={`Color ${c}`} />
      ))}
    </span>
  );
}

function Estados({ t, lider, avisar }) {
  const [borrando, setBorrando] = useState(null);
  const [moverA, setMoverA] = useState('');
  const [nuevo, setNuevo] = useState(null);   // { tipo, nombre }
  const cuenta = (id) => t.issues.filter((i) => i.estado_id === id).length;
  const hacer = async (fn) => { const r = await fn().then(() => '').catch((e) => e.message); avisar(r); return r; };

  return (
    <section className="tajustes__bloque">
      <div className="tajustes__h2">Estados<span className="tdim"> · el primero de «Sin empezar» (sin contar el backlog) es donde nacen las issues</span></div>
      <div className="tlistaaj">
        {GRUPOS_ESTADO.map((g) => (
          <div key={g.nombre} className="tlistaaj__grupo">
            <div className="tlistaaj__gcab">
              <span>{g.nombre}</span>
              <span className="tfill" />
              {lider && <button className="tbtn tbtn--plano" onClick={() => setNuevo({ tipo: g.tipos[g.tipos.length - 1], nombre: '' })}><IconPlus size={12} /> Estado</button>}
            </div>
            {t.estados.filter((e) => g.tipos.includes(e.tipo)).map((e) => (
              <div key={`${e.id}-${e.nombre}`} className="tlistaaj__fila">
                <Casilla estado={e} size={16} />
                <input className="tlistaaj__nombre" defaultValue={e.nombre} disabled={!lider} aria-label="Nombre del estado" maxLength={40}
                  onBlur={(ev) => { const v = ev.target.value.trim(); if (v && v !== e.nombre) hacer(() => api.editarEstado(e.id, { nombre: v })); }} />
                <Colores valor={e.color} disabled={!lider} onCambio={(c) => hacer(() => api.editarEstado(e.id, { color: c }))} />
                <span className="tdim tlistaaj__n">{cuenta(e.id)} issues</span>
                {lider && (borrando === e.id ? (
                  <span className="tlistaaj__borrar">
                    {cuenta(e.id) > 0 && (
                      <select className="tinput" value={moverA} onChange={(ev) => setMoverA(ev.target.value)} aria-label="Pasar sus issues a">
                        <option value="">Pasar sus issues a…</option>
                        {t.estados.filter((x) => x.id !== e.id).map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
                      </select>
                    )}
                    <button className="btn btn--sm btn--danger" disabled={cuenta(e.id) > 0 && !moverA}
                      onClick={async () => { if (!(await hacer(() => api.borrarEstado(e.id, moverA || null)))) { setBorrando(null); setMoverA(''); } }}>Borrar</button>
                    <button className="btn btn--sm btn--ghost" onClick={() => setBorrando(null)}>No</button>
                  </span>
                ) : (
                  <button className="ic" onClick={() => setBorrando(e.id)} aria-label={`Borrar ${e.nombre}`}><IconTrash size={14} /></button>
                ))}
              </div>
            ))}
            {nuevo && g.tipos.includes(nuevo.tipo) && (
              <form className="tlistaaj__fila" onSubmit={async (ev) => {
                ev.preventDefault();
                if (!nuevo.nombre.trim()) return;
                if (!(await hacer(() => api.crearEstado(t.proyectoId, { nombre: nuevo.nombre.trim(), tipo: nuevo.tipo })))) setNuevo(null);
              }}>
                <Casilla estado={{ tipo: nuevo.tipo, color: 'var(--ink-50)' }} size={16} />
                <input autoFocus className="tlistaaj__nombre" value={nuevo.nombre} placeholder="Nombre del estado" aria-label="Nombre del estado nuevo"
                  onChange={(ev) => setNuevo({ ...nuevo, nombre: ev.target.value })} onBlur={() => { if (!nuevo.nombre.trim()) setNuevo(null); }} />
                {g.tipos.length > 1 && (
                  <select className="tinput" value={nuevo.tipo} onChange={(ev) => setNuevo({ ...nuevo, tipo: ev.target.value })} aria-label="Tipo">
                    {g.tipos.map((x) => <option key={x} value={x}>{{ backlog: 'Backlog', pendiente: 'Por hacer', en_curso: 'En curso', revision: 'En revisión', hecho: 'Hecho', cancelado: 'Cancelado' }[x]}</option>)}
                  </select>
                )}
                <button className="btn btn--sm btn--primary" type="submit">Añadir</button>
              </form>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function Etiquetas({ t, lider, avisar }) {
  const [nombre, setNombre] = useState('');
  const [color, setColor] = useState(COLORES[1]);
  const cuenta = (id) => t.issues.filter((i) => i.etiquetas.includes(id)).length;
  const crear = async (e) => {
    e.preventDefault();
    if (!nombre.trim()) return;
    try { await api.crearEtiqueta(t.proyectoId, { nombre: nombre.trim(), color }); setNombre(''); avisar(''); } catch (err) { avisar(err.message); }
  };
  return (
    <section className="tajustes__bloque">
      <div className="tajustes__h2">Etiquetas</div>
      <div className="tetqs">
        {t.tablero.etiquetas.map((e) => (
          <span key={e.id} className="tetqaj" style={{ '--c': e.color }}>
            <PuntoCuadrado color={e.color} />
            {e.nombre}
            <span className="tdim">{cuenta(e.id)}</span>
            {lider && <button type="button" onClick={() => api.borrarEtiqueta(e.id).then(() => avisar('')).catch((err) => avisar(err.message))} aria-label={`Borrar ${e.nombre}`}>×</button>}
          </span>
        ))}
      </div>
      <form className="tajustes__fila" onSubmit={crear}>
        <input className="tinput" value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Nueva etiqueta" maxLength={40} aria-label="Nueva etiqueta" />
        <Colores valor={color} onCambio={setColor} />
        <button className="btn btn--sm" type="submit" disabled={!nombre.trim()}><IconPlus size={12} /> Añadir</button>
      </form>
    </section>
  );
}

function Fila({ titulo, sub, children }) {
  return (
    <div className="tajfila">
      <span className="tajfila__txt"><b>{titulo}</b><span>{sub}</span></span>
      {children}
    </div>
  );
}

export function AjustesIssues({ proyecto, lider }) {
  const t = useTablero(proyecto.id);
  const cfg = t.tablero.config || {};
  const [prefijo, setPrefijo] = useState(t.tablero.prefijo || '');
  const [aviso, setAviso] = useState('');
  useEffect(() => { setPrefijo(t.tablero.prefijo || ''); }, [t.tablero.prefijo]);
  const ajustar = (cambios) => api.ajustesIssues(proyecto.id, cambios).then(() => setAviso('')).catch((e) => setAviso(e.message));
  const ciclos = cfg.ciclos || {};
  const auto = cfg.automatismos || {};

  return (
    <div className="tajustes__sec">
      <div className="tajustes__cab">
        <h1>Issues</h1>
        <p>{lider ? 'Lo mismo que elegiste al crear el equipo. Los cambios valen para todos.' : 'Los ajustes de issues los lleva el líder del equipo.'}</p>
      </div>
      {aviso && <p className="terror">{aviso}</p>}

      <section className="tajustes__bloque">
        <div className="tajustes__h2">Ritmo</div>
        <div className="tajfilas">
          <Fila titulo="Identificador" sub="Prefijo de las issues y de las ramas del IDE">
            <input className="tinput mono tajfila__prefijo" value={prefijo} disabled={!lider} maxLength={5} aria-label="Identificador"
              onChange={(e) => setPrefijo(e.target.value.toUpperCase())}
              onBlur={() => { if (prefijo && prefijo !== t.tablero.prefijo) ajustar({ prefijo }); }} />
          </Fila>
          <Fila titulo="Trabajar por ciclos" sub={ciclos.activos ? `Cada ${ciclos.semanas} ${ciclos.semanas === 1 ? 'semana' : 'semanas'}, empiezan el ${DIAS[ciclos.dia_inicio || 0]}; lo pendiente pasa solo al siguiente` : 'Sin ciclos: las issues se ordenan solo por estado'}>
            {ciclos.activos && (
              <>
                <select className="tinput" disabled={!lider} value={ciclos.semanas} onChange={(e) => ajustar({ ciclos: { semanas: Number(e.target.value) } })} aria-label="Duración del ciclo">
                  {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n === 1 ? '1 semana' : `${n} semanas`}</option>)}
                </select>
                <select className="tinput" disabled={!lider} value={ciclos.dia_inicio || 0} onChange={(e) => ajustar({ ciclos: { dia_inicio: Number(e.target.value) } })} aria-label="Día de inicio">
                  {DIAS.map((d, n) => <option key={d} value={n}>Empiezan el {d}</option>)}
                </select>
              </>
            )}
            <Interruptor on={!!ciclos.activos} disabled={!lider} etiqueta="Trabajar por ciclos" onCambio={(v) => ajustar({ ciclos: { activos: v } })} />
          </Fila>
          <Fila titulo="Estimación" sub="Escala para los puntos, el avance del ciclo y la carga por persona">
            <div className="tseg" role="group" aria-label="Escala de estimación">
              {[['ninguna', 'Sin estimar'], ['fib', '1 · 2 · 3 · 5 · 8'], ['tallas', 'S · M · L']].map(([v, n]) => (
                <button key={v} type="button" disabled={!lider} className={cfg.estimacion === v ? 'is-on' : ''} aria-pressed={cfg.estimacion === v} onClick={() => ajustar({ estimacion: v })}>{n}</button>
              ))}
            </div>
          </Fila>
        </div>
      </section>

      <Estados t={t} lider={lider} avisar={setAviso} />
      <Etiquetas t={t} lider={lider} avisar={setAviso} />

      <section className="tajustes__bloque">
        <div className="tajustes__h2">Conectado con Lixbon IDE</div>
        <div className="tajfilas">
          <Fila titulo="Rama al empezar" sub="Vincular una rama lx/… pasa la issue a En curso">
            <Interruptor on={!!auto.rama} disabled={!lider} etiqueta="Rama al empezar" onCambio={(v) => ajustar({ automatismos: { rama: v } })} />
          </Fila>
          <Fila titulo="Seguir el PR" sub="Abrir el PR la pasa a En revisión; fusionarlo, a Hecho">
            <Interruptor on={!!auto.pr} disabled={!lider} etiqueta="Seguir el PR" onCambio={(v) => ajustar({ automatismos: { pr: v } })} />
          </Fila>
          <Fila titulo="Delegar a agentes" sub="El orquestador del IDE toma issues y deja su informe como comentario">
            <Interruptor on={!!auto.agentes} disabled={!lider} etiqueta="Delegar a agentes" onCambio={(v) => ajustar({ automatismos: { agentes: v } })} />
          </Fila>
        </div>
      </section>
    </div>
  );
}
