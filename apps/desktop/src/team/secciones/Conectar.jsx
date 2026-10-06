// Conectar.jsx — pantallas de "falta algo" de las secciones: conectar una
// clave, vincular el proyecto, o un error con salida.
import { useState } from 'react';
import { openExternal } from '../../lib/tauri';

export function Aviso({ icono, titulo, children, acciones }) {
  return (
    <div className="taviso">
      {icono && <span className="taviso__icono">{icono}</span>}
      <h1 className="taviso__t">{titulo}</h1>
      <div className="taviso__cuerpo">{children}</div>
      {acciones && <div className="taviso__acciones">{acciones}</div>}
    </div>
  );
}

export function Conectar({ icono, titulo, explicacion, marcador, enlace, enlaceTexto, estado, error, onConectar }) {
  const [clave, setClave] = useState('');
  const comprobando = estado === 'comprobando';
  return (
    <Aviso icono={icono} titulo={titulo}>
      <p>{explicacion}</p>
      <form className="taviso__form" onSubmit={(e) => { e.preventDefault(); onConectar(clave); }}>
        <input className="tinput mono" type="password" placeholder={marcador} value={clave} onChange={(e) => setClave(e.target.value)} spellCheck={false} autoComplete="off" aria-label={titulo} />
        <button className="btn btn--primary" type="submit" disabled={!clave.trim() || comprobando}>{comprobando ? 'Comprobando…' : 'Conectar'}</button>
      </form>
      {error && <p className="terror">{error}</p>}
      <button className="lk is-accent" onClick={() => openExternal(enlace)}>{enlaceTexto}</button>
    </Aviso>
  );
}
