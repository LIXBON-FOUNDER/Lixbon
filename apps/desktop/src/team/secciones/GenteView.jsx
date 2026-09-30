// GenteView.jsx — la gente del equipo con lo que está haciendo y su carga, los
// agentes del orquestador como parte del equipo, los amigos y las solicitudes.
import { useState } from 'react';
import { useTeamStore } from '../store/teamStore';
import { useIssuesStore } from '../store/issuesStore';
import { useTablero } from '../store/useTablero';
import { estadoDef } from '../lib/presencia';
import { ROLES_AGENTE, esCerrado, plano } from '../lib/issues';
import { TPanel, Cara, nombreDe } from '../ui/Panel';
import { IconAgente, IconBurbuja, IconPeople } from '../ui/icons';
import { IconSearch, IconCheck, IconPlus } from '../../components/Icons';

const ORDEN = { en_linea: 0, no_molestar: 1, invisible: 2, desconectado: 3 };
const PARA = {
  explorador: 'Busca y lee código para planificar. No edita nada.',
  implementador: 'Escribe el código de cada tarea en su propia rama.',
  revisor: 'Revisa los cambios antes del PR, sin tocarlos.',
  escalado: 'Retoma lo que se atasca tras dos intentos.',
};
const SOLO_LECTURA = new Set(['explorador', 'revisor']);

function Persona({ m, t, soyYo, onMensaje }) {
  const abrir = useIssuesStore((s) => s.abrir);
  const def = estadoDef(m.estado);
  const suyas = t.issues.filter((i) => i.asignado_id === m.usuario.id);
  const abiertas = suyas.filter((i) => !esCerrado(t.estadosPorId[i.estado_id]));
  const ahora = abiertas.find((i) => t.estadosPorId[i.estado_id]?.tipo === 'en_curso')
    || abiertas.find((i) => t.estadosPorId[i.estado_id]?.tipo === 'revision');
  const delCiclo = t.cicloHoy ? suyas.filter((i) => i.ciclo_id === t.cicloHoy.id) : suyas;
  const total = delCiclo.reduce((n, i) => n + (i.estimacion || 0), 0);
  const hechos = delCiclo.filter((i) => t.estadosPorId[i.estado_id]?.tipo === 'hecho').reduce((n, i) => n + (i.estimacion || 0), 0);
  return (
    <article className="tpersona">
      <div className="tpersona__cab">
        <Cara usuario={m.usuario} estado={m.estado} size={42} />
        <span className="tpersona__id">
          <span className="tpersona__nombre">
            {[m.usuario.first_name, m.usuario.last_name].filter(Boolean).join(' ') || nombreDe(m.usuario)}{soyYo ? ' (tú)' : ''}
            <span className={`trol ${m.rol === 'lider' ? 'is-lider' : ''}`}>{m.rol === 'lider' ? 'Líder' : 'Integrante'}</span>
          </span>
          <span className="tdim">{def.label}{m.usuario.username ? ` · @${m.usuario.username}` : ''}</span>
        </span>
        <span className="tfill" />
        {!soyYo && <button className="ic tpersona__msg" onClick={() => onMensaje(m.usuario.id)} aria-label={`Mensaje a ${nombreDe(m.usuario)}`}><IconBurbuja size={15} /></button>}
      </div>
      {ahora ? (
        <button className="tpersona__ahora" onClick={() => abrir(ahora.id)}>
          <span className="tdim">Ahora</span><span className="mono">{ahora.clave}</span><span className="tpersona__issue">{ahora.titulo}</span>
        </button>
      ) : <span className="tpersona__ahora is-libre"><span className="tdim">Sin nada en curso</span></span>}
      <div className="tpersona__carga">
        <span><b>{abiertas.length}</b> {abiertas.length === 1 ? 'abierta' : 'abiertas'}</span>
        {total > 0 && (
          <>
            <span className="tpersona__barra"><span style={{ width: `${(hechos / total) * 100}%` }} /></span>
            <span><b>{hechos}</b> de {total} pts{t.cicloHoy ? ' del ciclo' : ''}</span>
          </>
        )}
      </div>
    </article>
  );
}

function Agentes({ t }) {
  return (
    <section className="tsec" aria-label="Agentes del equipo">
      <div className="tsec__cab">
        <h2>Agentes del equipo</h2>
        <span className="tdim">Los roles del orquestador del IDE. Trabajan las issues que les delegas.</span>
      </div>
      <div className="tagentes">
        {Object.entries(ROLES_AGENTE).map(([id, r]) => {
          const suyas = t.issues.filter((i) => i.agente_rol === id && !esCerrado(t.estadosPorId[i.estado_id]));
          return (
            <div key={id} className="tagentecard">
              <div className="tagentecard__cab">
                <span className="tagente__ico is-grande"><IconAgente size={17} /></span>
                <span className="tagentecard__id"><b>{r.nombre}</b><span className="tdim">{r.modelo}</span></span>
              </div>
              <span className="tagentecard__para">{PARA[id]}</span>
              <span className="tagentecard__pie">
                {SOLO_LECTURA.has(id) && <span className="tchip">Solo lectura</span>}
                <span className={`tagentecard__estado ${suyas.length ? 'is-trabajando' : ''}`}>
                  <span className="tcuadro" />
                  {suyas.length ? (suyas.length === 1 ? `${suyas[0].clave} · en curso` : `${suyas.length} issues en curso`) : 'Libre'}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function GenteView() {
  const { usuario, amigos, solicitudes, abrirDirecto, soyLider, aceptarAmistad, pedirAmistad, invitar } = useTeamStore();
  const t = useTablero();
  const [filtro, setFiltro] = useState('equipo');
  const [q, setQ] = useState('');
  const [quien, setQuien] = useState('');
  const [aviso, setAviso] = useState('');
  const lider = soyLider();

  const miembros = [...t.miembros].sort((a, b) => (ORDEN[a.estado] ?? 3) - (ORDEN[b.estado] ?? 3) || nombreDe(a.usuario).localeCompare(nombreDe(b.usuario)));
  const enLinea = miembros.filter((m) => m.estado !== 'desconectado');
  const recibidas = solicitudes.filter((s) => s.direccion === 'recibida');
  const enviadas = solicitudes.filter((s) => s.direccion === 'enviada');
  const FILTROS = [
    ['equipo', 'Todo el equipo', miembros.length],
    ['linea', 'En línea', enLinea.length],
    ['agentes', 'Agentes', Object.keys(ROLES_AGENTE).length],
    ['amigos', 'Amigos', amigos.length],
    ['solicitudes', 'Solicitudes', recibidas.length],
  ];
  const busca = plano(q.trim());
  const pasa = (u) => !busca || plano(`${nombreDe(u)} ${u.last_name || ''} ${u.username || ''}`).includes(busca);
  const lista = (filtro === 'linea' ? enLinea : miembros).filter((m) => pasa(m.usuario));

  const mandar = async (e) => {
    e.preventDefault();
    const limpio = quien.trim();
    if (!limpio) return;
    const fallo = lider && filtro !== 'amigos' ? await invitar(t.proyectoId, limpio) : await pedirAmistad(limpio);
    setAviso(fallo || (lider && filtro !== 'amigos' ? `${limpio} ya está en ${t.proyecto.nombre}.` : `Solicitud enviada a ${limpio}.`));
    if (!fallo) setQuien('');
  };

  return (
    <>
      <TPanel id="gente-lado" className="tidx tidx--issues">
        <div className="tidx__titulo">Gente</div>
        {FILTROS.map(([id, nombre, n]) => (
          <button key={id} className={`tfila ${filtro === id ? 'is-on' : ''}`} onClick={() => setFiltro(id)}>
            <span className="tfila__n">{nombre}</span><span className="tfila__cuenta">{n || ''}</span>
          </button>
        ))}
        <div className="tfill" />
        {recibidas.length > 0 && filtro !== 'solicitudes' && (
          <div className="tidx__aviso">
            <b>{recibidas.length === 1 ? 'Una solicitud pendiente' : `${recibidas.length} solicitudes pendientes`}</b>
            <button className="btn btn--sm" onClick={() => setFiltro('solicitudes')}>Ver</button>
          </div>
        )}
      </TPanel>

      <TPanel id="gente" className="wb__grow tgentev">
        <div className="tcabeza">
          <div className="tcabeza__fila">
            <span className="tcabeza__ico"><IconPeople size={17} /></span>
            <h1 className="tcabeza__titulo">{t.proyecto?.nombre || 'Gente'}</h1>
            <span className="tfill" />
            <label className="tbuscar">
              <IconSearch size={13} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nombre o @usuario" aria-label="Buscar gente" />
            </label>
          </div>
          <p className="tcabeza__sub">{miembros.length} {miembros.length === 1 ? 'persona' : 'personas'} · {enLinea.length} en línea · {Object.keys(ROLES_AGENTE).length} agentes del orquestador</p>
        </div>

        <div className="tgentev__scroll">
          {(filtro === 'equipo' || filtro === 'linea') && (
            <>
              <div className="tpersonas">
                {lista.map((m) => <Persona key={m.usuario.id} m={m} t={t} soyYo={m.usuario.id === usuario?.id} onMensaje={abrirDirecto} />)}
                {!lista.length && <p className="tnota">{busca ? 'Nadie se llama así.' : 'No hay nadie aquí.'}</p>}
              </div>
              {filtro === 'equipo' && !busca && <Agentes t={t} />}
            </>
          )}
          {filtro === 'agentes' && <Agentes t={t} />}
          {filtro === 'amigos' && (
            <div className="tfilas">
              {amigos.filter((a) => pasa(a.usuario)).map((a) => (
                <div key={a.usuario.id} className="tfilap">
                  <Cara usuario={a.usuario} estado={a.estado} size={30} />
                  <span className="tfilap__id"><b>{nombreDe(a.usuario)}</b>{a.usuario.username && <span className="mono tdim">@{a.usuario.username}</span>}</span>
                  <span className="tdim">{estadoDef(a.estado).label}</span>
                  <button className="btn btn--ghost btn--sm" onClick={() => abrirDirecto(a.usuario.id)}><IconBurbuja size={13} /> Mensaje</button>
                </div>
              ))}
              {!amigos.length && <p className="tnota">Todavía no tienes amigos en Lixbon Team. Agrega a alguien con su correo o @usuario.</p>}
            </div>
          )}
          {filtro === 'solicitudes' && (
            <div className="tfilas">
              {recibidas.map((s) => (
                <div key={s.usuario.id} className="tfilap">
                  <Cara usuario={s.usuario} size={30} />
                  <span className="tfilap__id"><b>{nombreDe(s.usuario)}</b>{s.usuario.username && <span className="mono tdim">@{s.usuario.username}</span>}</span>
                  <span className="tdim">quiere agregarte</span>
                  <button className="btn btn--primary btn--sm" onClick={() => aceptarAmistad(s.usuario.id)}><IconCheck size={13} /> Aceptar</button>
                </div>
              ))}
              {enviadas.map((s) => (
                <div key={s.usuario.id} className="tfilap">
                  <Cara usuario={s.usuario} size={30} />
                  <span className="tfilap__id"><b>{nombreDe(s.usuario)}</b></span>
                  <span className="tdim">enviada · pendiente</span>
                </div>
              ))}
              {!recibidas.length && !enviadas.length && <p className="tnota">Nada pendiente.</p>}
            </div>
          )}

          {(filtro === 'amigos' || lider) && filtro !== 'agentes' && filtro !== 'solicitudes' && (
            <form className="tinvitar" onSubmit={mandar}>
              <span className="tinvitar__t">{filtro === 'amigos' ? 'Agregar a alguien' : `Invitar a ${t.proyecto?.nombre}`}</span>
              <input className="tinput" value={quien} onChange={(e) => { setQuien(e.target.value); setAviso(''); }} placeholder="correo o @usuario" spellCheck={false} aria-label="Correo o usuario" />
              <button className="btn btn--primary btn--sm" type="submit" disabled={!quien.trim()}><IconPlus size={13} /> {filtro === 'amigos' ? 'Enviar solicitud' : 'Invitar'}</button>
              {aviso && <span className="tnota">{aviso}</span>}
            </form>
          )}
        </div>
      </TPanel>
    </>
  );
}
