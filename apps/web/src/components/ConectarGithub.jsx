// Antes de mandar al usuario a GitHub, una ventana que cuenta qué va a pasar:
// los dos logos unidos, qué permite la conexión, los pasos numerados y un
// botón ancho para seguir. «Cancelar» es un enlace de texto debajo.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Rombos } from './Pulido';
import { IconX } from './Icons';
import { LogoMark } from './Logo';
import { LogoMarca } from './LogosMarcas';
import { useCierreAnimado } from '../hooks/useCierreAnimado';
import { useT } from '../i18n/useT';
import { conectarGithub } from '../lib/github';

export function ConectarGithub({ next = window.location.pathname, onClose }) {
  const t = useT('github');
  const tc = useT('common');
  const { cerrando, cerrar } = useCierreAnimado(onClose);
  const pasos = [t('connectStep1'), t('connectStep2'), t('connectStep3')];
  const [yendo, setYendo] = useState(false);

  return createPortal(
    <div className={cerrando ? 'modal-overlay is-closing' : 'modal-overlay'} onClick={cerrar}>
      <div className="modal gh-conectar" role="dialog" aria-modal="true" aria-labelledby="gh-conectar-titulo" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="icon-btn gh-conectar__x" onClick={cerrar} aria-label={tc('close')}><IconX /></button>
        <div className="gh-conectar__logos" aria-hidden="true">
          <span className="gh-conectar__logo"><LogoMark size={22} /></span>
          <span className="gh-conectar__union" />
          <span className="gh-conectar__logo"><LogoMarca id="github" size={22} /></span>
        </div>
        <h2 id="gh-conectar-titulo" className="modal__title gh-conectar__titulo">{t('connect')}</h2>
        <p className="modal__desc gh-conectar__desc">{t('connectDesc')}</p>
        <ol className="gh-conectar__pasos">
          {pasos.map((p, i) => (
            <li key={i}><span className="gh-conectar__num">{i + 1}</span>{p}</li>
          ))}
        </ol>
        {/* Al seguir, el botón pasa a «Conectando» con los rombos mientras se
            abre GitHub; «Cancelar» sigue debajo. */}
        <button type="button" className={`pill-btn pill-btn--primary gh-conectar__seguir ${yendo ? 'is-esperando' : ''}`}
          onClick={() => { setYendo(true); conectarGithub(next); }} disabled={yendo} aria-busy={yendo}>
          {yendo && <Rombos />}{yendo ? tc('connecting') : t('connectContinue')}
        </button>
        <button type="button" className="gh-conectar__cancelar" onClick={cerrar}>{tc('cancel')}</button>
      </div>
    </div>,
    document.body,
  );
}
