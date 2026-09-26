// GenteView.jsx — la gente del proyecto, los amigos y las solicitudes.
import { useState } from 'react';
import { useTeamStore } from '../store/teamStore';
import { estadoDef } from '../lib/presencia';
import { TPanel, TGutter, Cara, nombreDe } from '../ui/Panel';
import { IconSearch, IconCheck } from '../../components/Icons';
import { IconReply } from '../ui/icons';

const ORDEN = { en_linea: 0, no_molestar: 1, invisible: 2, desconectado: 3 };
const plano = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

function Invitar({ proyecto }) {
  const invitar = useTeamStore((s) => s.invitar);
  const [quien, setQuien] = useState('');
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');
  const mandar = async (e) => {
    e.preventDefault();
    const limpio = quien.trim();
    if (!limpio) return;
    const fallo = await invitar(proyecto.id, limpio);
    if (fallo) { setError(fallo); setAviso(''); return; }
    setError('');
    setAviso(`${limpio} ya está en ${proyecto.nombre}.`);
    setQuien('');
  };
  return (
    <form className="tform tform--suelto" onSubmit={mandar}>
      <span className="tform__t">Invitar a {proyecto.nombre}</span>
      <span className="tnota">Entra como integrante. Solo el líder puede invitar y quitar gente.</span>
      <label className="tcampo">Correo o @usuario
        <input className="tinput" value={quien} onChange={(e) => setQuien(e.target.value)} spellCheck={false} />
      </label>
      {error && <p className="terror">{error}</p>}
      {aviso && <p className="tok">{aviso}</p>}
      <button className="btn btn--primary btn--sm" type="submit" disabled={!quien.trim()}>Invitar</button>
    </form>
  );
}

export function GenteView() {
  const { proyectoActivo, usuario, amigos, solicitudes, abrirDirecto, soyLider, aceptarAmistad, pedirAmistad, anchos } = useTeamStore();
  const [tab, setTab] = useState('proyecto');
  const [filtro, setFiltro] = useState('');
  const [amigo, setAmigo] = useState('');
  const [avisoAmigo, setAvisoAmigo] = useState('');
  const proyecto = proyectoActivo();
  const lider = soyLider();

  const miembros = (proyecto?.miembros || []).map((m) => ({ usuario: m.usuario, estado: m.estado, rol: m.rol }));
  const listaAmigos = amigos.map((a) => ({ usuario: a.usuario, estado: a.estado, rol: 'amigo' }));
  const recibidas = solicitudes.filter((s) => s.direccion === 'recibida');
  const enviadas = solicitudes.filter((s) => s.direccion === 'enviada');
  const enLinea = miembros.filter((m) => m.estado !== 'desconectado');
  const TABS = [
    ['proyecto', 'Del proyecto', miembros.length],
    ['amigos', 'Amigos', listaAmigos.length],
    ['linea', 'En línea ahora', enLinea.length],
  ];
  const base = tab === 'amigos' ? listaAmigos : tab === 'linea' ? enLinea : miembros;
  const busca = plano(filtro.trim());
  const gente = base
    .filter((m) => !busca || plano(`${nombreDe(m.usuario)} ${m.usuario.username || ''}`).includes(busca))
    .sort((a, b) => (ORDEN[a.estado] ?? 3) - (ORDEN[b.estado] ?? 3) || nombreDe(a.usuario).localeCompare(nombreDe(b.usuario)));

  const mandarAmistad = async (e) => {
    e.preventDefault();
    if (!amigo.trim()) return;
    const fallo = await pedirAmistad(amigo.trim());
    setAvisoAmigo(fallo || `Solicitud enviada a ${amigo.trim()}.`);
    if (!fallo) setAmigo('');
  };

  return (
    <>
      <TPanel id="gente-lado" style={{ width: anchos.lista }}>
        <header className="tpanelhead"><span className="tpanelhead__s">Gente</span></header>
        <div className="tlado">
          {TABS.map(([id, nombre, n]) => (
            <button key={id} className={`tfila ${tab === id ? 'is-on' : ''}`} onClick={() => setTab(id)}>
              <span className="tfila__n">{nombre}</span><span className="mono tdim">{n}</span>
            </button>
          ))}
        </div>
      </TPanel>
      <TGutter clave="lista" min={180} max={320} />
      <TPanel id="gente" className="wb__grow">
        <header className="tpanelhead">
          <span className="tpanelhead__t">{TABS.find((t) => t[0] === tab)[1]}</span>
          <span className="mono tdim">{gente.length}</span>
          <div className="tfill" />
          <label className="tbuscar">
            <IconSearch size={13} />
            <input value={filtro} onChange={(e) => setFiltro(e.target.value)} placeholder="Buscar por nombre o @usuario" aria-label="Buscar gente" />
          </label>
        </header>
        <div className="tgente mono"><span /><span>Nombre</span><span>Estado</span><span>Rol</span><span /></div>
        <div className="tlista">
          {gente.map((m) => {
            const def = estadoDef(m.estado);
            const soyYo = m.usuario.id === usuario?.id;
            return (
              <div key={m.usuario.id} className="tgente tgente__fila">
                <Cara usuario={m.usuario} estado={m.estado} size={30} />
                <span className="tgente__n">
                  <span>{[m.usuario.first_name, m.usuario.last_name].filter(Boolean).join(' ') || nombreDe(m.usuario)}{soyYo ? ' (tú)' : ''}</span>
                  {m.usuario.username && <span className="mono tdim">@{m.usuario.username}</span>}
                </span>
                <span style={{ color: def.color }}>{def.label}</span>
                <span className={`mono ${m.rol === 'lider' ? 'tacento' : 'tdim'}`}>{m.rol === 'lider' ? 'Líder' : m.rol === 'amigo' ? 'Amigo' : 'Integrante'}</span>
                <span className="tgente__acc">
                  {!soyYo && <button className="btn btn--ghost btn--sm" onClick={() => abrirDirecto(m.usuario.id)}><IconReply size={13} /> Mensaje</button>}
                </span>
              </div>
            );
          })}
          {!gente.length && <p className="tidx__vacio">{busca ? 'Nadie se llama así.' : tab === 'amigos' ? 'Todavía no tienes amigos en Lixbon Team.' : 'No hay nadie aquí.'}</p>}
        </div>
      </TPanel>
      <TGutter clave="info" min={280} max={420} lado="izquierda" />
      <TPanel id="gente-invitar" style={{ width: anchos.info }}>
        <div className="tlado tlado--suelto">
          {proyecto && lider && <Invitar proyecto={proyecto} />}
          <section className="tbloque">
            <span className="tcap">Solicitudes de amistad {recibidas.length > 0 && <span className="mono tacento">{recibidas.length}</span>}</span>
            {recibidas.map((s) => (
              <div key={s.usuario.id} className="tsolicitud">
                <Cara usuario={s.usuario} size={26} />
                <span className="tgente__n"><span>{nombreDe(s.usuario)}</span>{s.usuario.username && <span className="mono tdim">@{s.usuario.username}</span>}</span>
                <button className="tfila__ok" onClick={() => aceptarAmistad(s.usuario.id)} aria-label="Aceptar la solicitud"><IconCheck size={14} /></button>
              </div>
            ))}
            {!recibidas.length && <span className="tnota">Nada pendiente.</span>}
          </section>
          <form className="tbloque" onSubmit={mandarAmistad}>
            <span className="tcap">Agregar a alguien</span>
            <input className="tinput" value={amigo} onChange={(e) => { setAmigo(e.target.value); setAvisoAmigo(''); }} placeholder="correo o @usuario" spellCheck={false} aria-label="Correo o usuario" />
            {avisoAmigo && <p className="tnota">{avisoAmigo}</p>}
            <button className="btn btn--ghost btn--sm" type="submit" disabled={!amigo.trim()}>Enviar solicitud</button>
          </form>
          {enviadas.length > 0 && (
            <section className="tbloque">
              <span className="tcap">Enviadas</span>
              {enviadas.map((s) => <div key={s.usuario.id} className="tsolicitud"><Cara usuario={s.usuario} size={22} /><span className="tgente__n">{nombreDe(s.usuario)}</span><span className="tdim">pendiente</span></div>)}
            </section>
          )}
        </div>
      </TPanel>
    </>
  );
}
