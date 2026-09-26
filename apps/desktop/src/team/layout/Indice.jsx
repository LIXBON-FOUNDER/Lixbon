// Indice.jsx — la columna izquierda: lo que te espera arriba, después los
// canales del proyecto y los directos. Una sola lista; solo cambia la fila encendida.
import { useEffect, useRef, useState } from 'react';
import { useTeamStore } from '../store/teamStore';
import { useAcopladosStore } from '../store/acopladosStore';
import { ESTADOS, estadoDef } from '../lib/presencia';
import { Cara, nombreDe } from '../ui/Panel';
import { IconPlus, IconSearch, IconX, IconCheck, IconPanelRight, IconChevronDown } from '../../components/Icons';
import { IconHash, IconLock } from '../ui/icons';

const plano = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

function Fila({ encendida, negrita, onClick, icono, nombre, extra, title }) {
  return (
    <button className={`tfila ${encendida ? 'is-on' : ''} ${negrita ? 'is-nuevo' : ''}`} onClick={onClick} title={title || nombre}>
      {icono}
      <span className="tfila__n">{nombre}</span>
      {extra}
    </button>
  );
}

function NuevoCanal({ proyecto, lider, onCerrar }) {
  const crearCanal = useTeamStore((s) => s.crearCanal);
  const [nombre, setNombre] = useState('');
  const [tipo, setTipo] = useState('publico');
  const [error, setError] = useState('');
  const crear = async (e) => {
    e.preventDefault();
    const limpio = nombre.trim().replace(/^#/, '');
    if (!limpio) return;
    const fallo = await crearCanal(proyecto.id, { nombre: limpio, tipo });
    if (fallo) setError(fallo);
    else onCerrar();
  };
  return (
    <form className="tform" onSubmit={crear}>
      <input className="tinput" value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="nombre-del-canal" autoFocus maxLength={40} aria-label="Nombre del canal" />
      <div className="tseg">
        <button type="button" className={tipo === 'publico' ? 'is-on' : ''} onClick={() => setTipo('publico')}><IconHash size={12} /> Público</button>
        <button type="button" className={tipo === 'privado' ? 'is-on' : ''} onClick={() => setTipo('privado')} disabled={!lider} title={lider ? 'Solo quien tú elijas' : 'Solo el líder crea canales privados'}><IconLock size={12} /> Privado</button>
      </div>
      <p className="tnota">{tipo === 'publico' ? 'Lo verá todo el proyecto.' : 'Empiezas solo; a los demás los añades desde Ajustes.'}</p>
      {error && <p className="terror">{error}</p>}
      <button className="btn btn--primary btn--sm" type="submit" disabled={!nombre.trim()}>Crear canal</button>
    </form>
  );
}

function AgregarAmigo() {
  const pedirAmistad = useTeamStore((s) => s.pedirAmistad);
  const [quien, setQuien] = useState('');
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');
  const mandar = async (e) => {
    e.preventDefault();
    const limpio = quien.trim();
    if (!limpio) return;
    const fallo = await pedirAmistad(limpio);
    if (fallo) { setError(fallo); setAviso(''); return; }
    setError('');
    setAviso(`Solicitud enviada a ${limpio}.`);
    setQuien('');
  };
  return (
    <form className="tform" onSubmit={mandar}>
      <input className="tinput" value={quien} onChange={(e) => setQuien(e.target.value)} placeholder="correo o @usuario" autoFocus spellCheck={false} aria-label="Correo o usuario" />
      <p className="tnota">Con los compañeros de un proyecto no hace falta: ya podéis escribiros.</p>
      {error && <p className="terror">{error}</p>}
      {aviso && <p className="tok">{aviso}</p>}
      <button className="btn btn--primary btn--sm" type="submit" disabled={!quien.trim()}>Enviar solicitud</button>
    </form>
  );
}

function MiEstado() {
  const usuario = useTeamStore((s) => s.usuario);
  const presencia = useTeamStore((s) => s.presencia);
  const cambiarPresencia = useTeamStore((s) => s.cambiarPresencia);
  const [abierto, setAbierto] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!abierto) return undefined;
    const fuera = (e) => { if (!ref.current?.contains(e.target)) setAbierto(false); };
    window.addEventListener('pointerdown', fuera);
    return () => window.removeEventListener('pointerdown', fuera);
  }, [abierto]);
  const def = estadoDef(presencia);
  return (
    <div className="tyo" ref={ref}>
      {abierto && (
        <div className="tmenu tyo__menu">
          {ESTADOS.map((e) => (
            <button key={e.id} className={`tmenu__item ${e.id === presencia ? 'is-on' : ''}`} onClick={() => { cambiarPresencia(e.id); setAbierto(false); }}>
              <span className="tpunto" style={{ background: e.color }} />
              <span className="tmenu__txt"><span>{e.label}</span><span className="tmenu__ayuda">{e.ayuda}</span></span>
            </button>
          ))}
        </div>
      )}
      <button className="tyo__btn" onClick={() => setAbierto((v) => !v)} aria-label="Cambiar tu estado">
        <Cara usuario={usuario} estado={presencia} size={24} />
        <span className="tyo__t">
          <span>{[usuario?.first_name, usuario?.last_name].filter(Boolean).join(' ') || nombreDe(usuario)}</span>
          <span style={{ color: def.color }}>{def.label}</span>
        </span>
        <IconChevronDown size={13} />
      </button>
    </div>
  );
}

export function Indice() {
  const {
    proyectoActivo, directos, amigos, solicitudes, canalId, vista, noLeidos,
    abrirCanal, abrirDirecto, aceptarAmistad, soyLider, escribiendoEn,
  } = useTeamStore();
  const { ids: acoplados, cargar } = useAcopladosStore();
  const [filtro, setFiltro] = useState('');
  const [creando, setCreando] = useState(false);
  const [agregando, setAgregando] = useState(false);
  const buscarRef = useRef(null);

  useEffect(() => { cargar(); }, [cargar]);
  useEffect(() => {
    const alPulsar = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); buscarRef.current?.focus(); buscarRef.current?.select(); }
    };
    window.addEventListener('keydown', alPulsar);
    return () => window.removeEventListener('keydown', alPulsar);
  }, []);

  const proyecto = proyectoActivo();
  const lider = soyLider();
  const busca = plano(filtro.trim());
  const cabe = (t) => !busca || plano(t).includes(busca);
  const encendido = (id) => vista === 'chat' && canalId === id;

  const canales = (proyecto?.canales || []).filter((c) => cabe(c.nombre));
  const vivo = (id) => (noLeidos[id] || 0) > 0 || escribiendoEn(id).length > 0;
  const recibidas = solicitudes.filter((s) => s.direccion === 'recibida');
  const enviadas = solicitudes.filter((s) => s.direccion === 'enviada');
  const charlas = directos.filter((d) => cabe(nombreDe(d.con)));
  const conDirecto = new Set(directos.map((d) => d.con?.id));
  const sinHablar = amigos.filter((a) => !conDirecto.has(a.usuario?.id) && cabe(nombreDe(a.usuario)));

  const esperanCanales = canales.filter((c) => vivo(c.id) && !encendido(c.id));
  const esperanDirectos = charlas.filter((d) => (noLeidos[d.id] || 0) > 0 && !encendido(d.id));
  const restoCanales = canales.filter((c) => !esperanCanales.includes(c));
  const restoDirectos = charlas.filter((d) => !esperanDirectos.includes(d));

  const filaCanal = (c) => {
    const n = noLeidos[c.id] || 0;
    const escribe = escribiendoEn(c.id).length > 0;
    return (
      <Fila
        key={c.id}
        encendida={encendido(c.id)}
        negrita={n > 0}
        onClick={() => abrirCanal(c.id)}
        title={c.tema || c.nombre}
        icono={c.tipo === 'privado' ? <IconLock size={13} className="tdim" /> : <span className="tfila__hash mono">#</span>}
        nombre={c.nombre}
        extra={(
          <>
            {(acoplados || []).includes(c.id) && <IconPanelRight size={11} className="tfila__ide" />}
            {escribe && <span className="tpuntos"><span /><span /><span /></span>}
            {n > 0 && !encendido(c.id) && <span className="tfila__c mono">{n > 99 ? '99+' : n}</span>}
          </>
        )}
      />
    );
  };
  const filaPersona = (u, estado, canal = null) => {
    const n = canal ? noLeidos[canal] || 0 : 0;
    return (
      <Fila
        key={u.id}
        encendida={canal && encendido(canal)}
        negrita={n > 0}
        onClick={() => (canal ? abrirCanal(canal) : abrirDirecto(u.id))}
        icono={<Cara usuario={u} estado={estado} size={18} />}
        nombre={nombreDe(u)}
        title={`${nombreDe(u)} · ${estadoDef(estado).label}`}
        extra={n > 0 && !encendido(canal) && <span className="tfila__globo mono">{n > 99 ? '99+' : n}</span>}
      />
    );
  };
  const cuantas = (acoplados || []).length;

  return (
    <>
      <div className="tidx__buscar">
        <IconSearch size={14} />
        <input
          ref={buscarRef}
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { setFiltro(''); e.currentTarget.blur(); } }}
          placeholder="Buscar en el índice"
          aria-label="Buscar en el índice"
          spellCheck={false}
        />
        {filtro
          ? <button className="ic" onClick={() => setFiltro('')} aria-label="Limpiar"><IconX size={12} /></button>
          : <span className="mono tdim tidx__k">Ctrl K</span>}
      </div>

      <div className="tidx__scroll">
        {(recibidas.length > 0 || esperanCanales.length > 0 || esperanDirectos.length > 0) && (
          <div className="tgrupo">
            <div className="tcap">Te esperan</div>
            {recibidas.map((s) => (
              <div key={s.usuario.id} className="tfila tfila--quieta">
                <Cara usuario={s.usuario} size={18} />
                <span className="tfila__n">{nombreDe(s.usuario)} quiere hablar contigo</span>
                <button className="tfila__ok" onClick={() => aceptarAmistad(s.usuario.id)} aria-label="Aceptar la solicitud"><IconCheck size={13} /></button>
              </div>
            ))}
            {esperanDirectos.map((d) => filaPersona(d.con, d.estado, d.id))}
            {esperanCanales.map(filaCanal)}
          </div>
        )}

        {proyecto && (!busca || restoCanales.length > 0) && (
          <div className="tgrupo">
            <div className="tcap">
              Canales
              <button className="ic" onClick={() => setCreando((v) => !v)} aria-label="Canal nuevo">{creando ? <IconX size={12} /> : <IconPlus size={13} />}</button>
            </div>
            {creando && <NuevoCanal proyecto={proyecto} lider={lider} onCerrar={() => setCreando(false)} />}
            {restoCanales.map(filaCanal)}
            {!proyecto.canales.length && !busca && <p className="tidx__vacio">Este proyecto todavía no tiene canales. Crea el primero con +.</p>}
          </div>
        )}

        <div className="tgrupo">
          <div className="tcap">
            Directos
            <button className="ic" onClick={() => setAgregando((v) => !v)} aria-label="Agregar a alguien">{agregando ? <IconX size={12} /> : <IconPlus size={13} />}</button>
          </div>
          {agregando && <AgregarAmigo />}
          {restoDirectos.map((d) => filaPersona(d.con, d.estado, d.id))}
          {sinHablar.map((a) => filaPersona(a.usuario, a.estado))}
          {enviadas.map((s) => (
            <div key={s.usuario.id} className="tfila tfila--quieta">
              <Cara usuario={s.usuario} size={18} />
              <span className="tfila__n">{nombreDe(s.usuario)}</span>
              <span className="tdim tfila__pend">pendiente</span>
            </div>
          ))}
          {!charlas.length && !sinHablar.length && !solicitudes.length && !busca && (
            <p className="tidx__vacio">Escribe a un compañero desde Gente, o agrega a alguien con +.</p>
          )}
        </div>
        {busca && !canales.length && !charlas.length && !sinHablar.length && <p className="tidx__vacio">Nada que se llame así.</p>}
      </div>

      <div className="tidx__pie">
        <div className="tidx__ide">
          <IconPanelRight size={14} className="tacento" />
          <span>Acoplado al IDE</span>
          <span className="mono tdim">{cuantas === 1 ? '1 chat' : `${cuantas} chats`}</span>
        </div>
        <MiEstado />
      </div>
    </>
  );
}
