// Espacio del chat: en el pie del cuadro de mensaje, junto al repo. Solo se
// elige antes del primer mensaje; después la conversación ya es del espacio.
import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';
import { Link } from '../i18n/link';
import { Icono, IconCheck, IconChevron } from './Icons';
import { useMenu } from './GithubChat';
import { listarEspacios } from '../lib/espacios';

export function MenuEspacio({ espacio, onChange, fijo = false }) {
  const t = useT('espacios');
  const m = useMenu();
  const [espacios, setEspacios] = useState(undefined);

  useEffect(() => {
    if (!m.abierto || espacios !== undefined) return;
    listarEspacios().then(setEspacios).catch(() => setEspacios(null));
  }, [m.abierto, espacios]);

  if (fijo && !espacio) return null;
  const nombre = espacio?.nombre || t('chooseSpace');

  if (fijo) {
    return (
      <div className="modelo-menu gh-menu">
        <Link to={`/espacios/${espacio.id}`} className="modelo-menu__btn is-on" title={t('inSpace', { nombre: espacio.nombre })}>
          <Icono nombre="carpeta" size={15} />
          <span className="modelo-menu__nombre">{espacio.nombre}</span>
        </Link>
      </div>
    );
  }

  const elegir = (e) => { onChange(e); m.cerrar(); };
  return (
    <div className="modelo-menu gh-menu" ref={m.raiz}>
      <button type="button" className={`modelo-menu__btn ${m.abierto ? 'is-open' : ''} ${espacio ? 'is-on' : ''}`}
        onClick={() => m.setAbierto(!m.abierto)} aria-haspopup="menu" aria-expanded={m.abierto} aria-label={t('spaceAria')}>
        <Icono nombre="carpeta" size={15} />
        <span className="modelo-menu__nombre">{nombre}</span>
        <IconChevron size={14} open={m.abierto} className="modelo-menu__chevron" />
      </button>
      {m.montado && (
        <div ref={m.panel} className={`modelo-menu__panel gh-menu__panel ${m.abajo ? 'is-abajo' : 'is-arriba'} ${m.cerrando ? 'is-cerrando' : ''}`}
          role="menu" aria-label={t('spaceAria')}>
          <p className="modelo-menu__etq">{t('title')}</p>
          <div className="modelo-menu__lista">
            {espacios === undefined && <p className="gh-menu__nota">{t('loading')}</p>}
            {espacios === null && <p className="gh-menu__nota">{t('loadError')}</p>}
            {(espacios || []).map((e) => {
              const sel = espacio?.id === e.id;
              return (
                <button key={e.id} type="button" role="menuitemradio" aria-checked={sel}
                  className={`modelo-menu__opt ${sel ? 'is-sel' : ''}`} onClick={() => elegir({ id: e.id, nombre: e.nombre, repo: e.repo || null })}>
                  <span className="gh-menu__dos">
                    <span>{e.nombre}</span>
                    {e.descripcion && <small>{e.descripcion}</small>}
                  </span>
                  {sel && <IconCheck size={14} />}
                </button>
              );
            })}
          </div>
          <div className="modelo-menu__sep" />
          {espacio && (
            <button type="button" role="menuitem" className="modelo-menu__opt" onClick={() => elegir(null)}>
              <span className="modelo-menu__txt">{t('noSpace')}</span>
            </button>
          )}
          <Link role="menuitem" className="modelo-menu__opt" to="/espacios" onClick={m.cerrar}>
            <span className="modelo-menu__txt">{t('manageSpaces')}</span>
            <Icono nombre="siguiente" size={14} />
          </Link>
        </div>
      )}
    </div>
  );
}
