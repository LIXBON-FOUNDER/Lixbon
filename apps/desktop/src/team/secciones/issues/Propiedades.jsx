// Propiedades.jsx — los selectores de una issue (estado, prioridad, persona,
// etiquetas, ciclo, proyecto, estimación, fecha, agente). Los usan el detalle y
// el formulario de nueva issue, así que se ven y se comportan igual en los dos.
import { Desplegable, Opciones } from '../../ui/Menu';
import { Casilla, Rombos, Etiqueta, PuntoCuadrado } from '../../ui/Marcas';
import { Cara, nombreDe } from '../../ui/Panel';
import { IconAgente, IconCalendar } from '../../ui/icons';
import {
  PRIORIDADES, prioridadDe, ESCALAS, nombreEstimacion, ROLES_AGENTE, fechaCorta, vencimiento,
} from '../../lib/issues';

function Boton({ alternar, children, vacio, etiqueta }) {
  return (
    <button type="button" className={`tprop__valor ${vacio ? 'is-vacio' : ''}`} onClick={alternar} aria-label={etiqueta}>
      {children}
    </button>
  );
}

export function SelEstado({ t, valor, onCambio }) {
  const e = t.estadosPorId[valor];
  return (
    <Desplegable boton={({ alternar }) => (
      <Boton alternar={alternar} etiqueta="Estado"><Casilla estado={e} size={15} />{e?.nombre || 'Estado'}</Boton>
    )}>
      {(cerrar) => (
        <Opciones cerrar={cerrar} valor={valor} onElegir={onCambio}
          opciones={t.estados.map((x) => ({ valor: x.id, nombre: x.nombre, icono: <Casilla estado={x} size={15} /> }))} />
      )}
    </Desplegable>
  );
}

export function SelPrioridad({ valor, onCambio }) {
  const p = prioridadDe(valor);
  return (
    <Desplegable boton={({ alternar }) => (
      <Boton alternar={alternar} vacio={!valor} etiqueta="Prioridad"><Rombos prioridad={valor} />{p.nombre}</Boton>
    )}>
      {(cerrar) => (
        <Opciones cerrar={cerrar} valor={valor} onElegir={onCambio}
          opciones={PRIORIDADES.map((x) => ({ valor: x.valor, nombre: x.nombre, icono: <Rombos prioridad={x.valor} /> }))} />
      )}
    </Desplegable>
  );
}

export function SelPersona({ t, valor, onCambio, etiqueta = 'Asignada a' }) {
  const m = t.gente[valor];
  return (
    <Desplegable boton={({ alternar }) => (
      <Boton alternar={alternar} vacio={!m} etiqueta={etiqueta}>
        {m ? <><Cara usuario={m.usuario} size={20} />{nombreDe(m.usuario)}</> : 'Sin asignar'}
      </Boton>
    )}>
      {(cerrar) => (
        <Opciones cerrar={cerrar} valor={valor ?? null} onElegir={onCambio} buscar={t.miembros.length > 6}
          opciones={[
            { valor: null, nombre: 'Sin asignar' },
            ...t.miembros.map((x) => ({
              valor: x.usuario.id,
              nombre: [x.usuario.first_name, x.usuario.last_name].filter(Boolean).join(' ') || x.usuario.username,
              ayuda: x.usuario.id === t.usuario?.id ? 'Tú' : undefined,
              icono: <Cara usuario={x.usuario} size={20} />,
            })),
          ]} />
      )}
    </Desplegable>
  );
}

export function SelEtiquetas({ t, valor = [], onCambio }) {
  const puestas = valor.map((id) => t.etiquetasPorId[id]).filter(Boolean);
  const alternarUna = (id) => onCambio(valor.includes(id) ? valor.filter((x) => x !== id) : [...valor, id]);
  return (
    <Desplegable boton={({ alternar }) => (
      <Boton alternar={alternar} vacio={!puestas.length} etiqueta="Etiquetas">
        {puestas.length ? puestas.map((e) => <Etiqueta key={e.id} etiqueta={e} />) : 'Añadir etiqueta'}
      </Boton>
    )}>
      {(cerrar) => (
        <Opciones cerrar={cerrar} multiple valor={valor} onElegir={alternarUna} buscar vacio="Sin etiquetas: créalas en Ajustes del equipo."
          opciones={t.tablero.etiquetas.map((e) => ({ valor: e.id, nombre: e.nombre, icono: <PuntoCuadrado color={e.color} /> }))} />
      )}
    </Desplegable>
  );
}

export function SelCiclo({ t, valor, onCambio }) {
  const c = t.ciclosPorId[valor];
  if (!t.tablero.config?.ciclos?.activos && !c) return <span className="tprop__nada">Ciclos desactivados</span>;
  return (
    <Desplegable boton={({ alternar }) => (
      <Boton alternar={alternar} vacio={!c} etiqueta="Ciclo">
        {c ? `Ciclo ${c.numero} · ${fechaCorta(c.empieza)} – ${fechaCorta(c.termina)}` : 'Sin ciclo'}
      </Boton>
    )}>
      {(cerrar) => (
        <Opciones cerrar={cerrar} valor={valor ?? null} onElegir={onCambio}
          opciones={[
            { valor: null, nombre: 'Sin ciclo' },
            ...t.tablero.ciclos.filter((x) => x.termina >= (t.cicloHoy?.empieza || '')).map((x) => ({
              valor: x.id,
              nombre: `Ciclo ${x.numero}`,
              ayuda: `${fechaCorta(x.empieza)} – ${fechaCorta(x.termina)}${x.id === t.cicloHoy?.id ? ' · actual' : ''}`,
            })),
          ]} />
      )}
    </Desplegable>
  );
}

export function SelIniciativa({ t, valor, onCambio }) {
  const x = t.iniciativasPorId[valor];
  return (
    <Desplegable boton={({ alternar }) => (
      <Boton alternar={alternar} vacio={!x} etiqueta="Proyecto">
        {x ? <><PuntoCuadrado color={x.color} />{x.nombre}</> : 'Sin proyecto'}
      </Boton>
    )}>
      {(cerrar) => (
        <Opciones cerrar={cerrar} valor={valor ?? null} onElegir={onCambio} vacio="Sin proyectos todavía."
          opciones={[
            { valor: null, nombre: 'Sin proyecto' },
            ...t.tablero.iniciativas.map((i) => ({ valor: i.id, nombre: i.nombre, icono: <PuntoCuadrado color={i.color} /> })),
          ]} />
      )}
    </Desplegable>
  );
}

export function SelEstimacion({ t, valor, onCambio }) {
  const escala = t.tablero.config?.estimacion || 'fib';
  if (escala === 'ninguna') return <span className="tprop__nada">Sin estimación</span>;
  return (
    <Desplegable boton={({ alternar }) => (
      <Boton alternar={alternar} vacio={valor == null} etiqueta="Estimación">
        {valor == null ? 'Sin estimar' : nombreEstimacion(escala, valor)}
      </Boton>
    )}>
      {(cerrar) => (
        <Opciones cerrar={cerrar} valor={valor ?? null} onElegir={onCambio}
          opciones={[{ valor: null, nombre: 'Sin estimar' }, ...ESCALAS[escala].map((n) => ({ valor: n, nombre: nombreEstimacion(escala, n) }))]} />
      )}
    </Desplegable>
  );
}

export function SelFecha({ valor, onCambio, cerrada }) {
  const v = vencimiento(valor, cerrada);
  return (
    <label className={`tprop__valor tprop__fecha ${!valor ? 'is-vacio' : ''} is-${v?.tono || 'normal'}`}>
      <IconCalendar size={14} />
      <span>{v ? v.texto : 'Sin fecha'}</span>
      <input type="date" value={valor || ''} onChange={(e) => onCambio(e.target.value || null)} aria-label="Fecha límite" />
    </label>
  );
}

export function SelAgente({ valor, onCambio }) {
  const r = ROLES_AGENTE[valor];
  return (
    <Desplegable boton={({ alternar }) => (
      <Boton alternar={alternar} vacio={!r} etiqueta="Agente">
        {r ? <><span className="tagente__ico"><IconAgente size={13} /></span>{r.nombre} · {r.modelo}</> : 'Ningún agente'}
      </Boton>
    )}>
      {(cerrar) => (
        <Opciones cerrar={cerrar} valor={valor ?? null} onElegir={onCambio}
          opciones={[
            { valor: null, nombre: 'Ningún agente' },
            ...Object.entries(ROLES_AGENTE).map(([id, x]) => ({ valor: id, nombre: x.nombre, ayuda: x.modelo, icono: <span className="tagente__ico"><IconAgente size={13} /></span> })),
          ]} />
      )}
    </Desplegable>
  );
}
