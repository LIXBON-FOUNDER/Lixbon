import { Link } from '../i18n/link';
import { useT } from '../i18n/useT';
import { Enfasis } from './Enfasis';
import { IconCorazon, IconGrid, IconLayers, IconTerminal } from './Icons';

// Mientras no haya equipos para ejecutar los modelos en la web, el chat queda en
// pausa: sin caja de mensaje, con el historial a la vista y los atajos al resto
// de lixbon. Se abre y se cierra desde Admin › Chat web (lib/chatWeb.js).

const ANCHOS = [960, 1440, 1774];
const srcSet = (ext) => ANCHOS.map((a) => `/laminas/puerto-tranquilo-${a}.${ext} ${a}w`).join(', ');

const ACCESOS = [
  { to: '/visuals', icono: IconLayers, titulo: 'accesoVisuals', texto: 'accesoVisualsTexto' },
  { to: '/remote', icono: IconTerminal, titulo: 'accesoRemoto', texto: 'accesoRemotoTexto' },
  { to: '/apps', icono: IconGrid, titulo: 'accesoApps', texto: 'accesoAppsTexto' },
];

// «Puerto tranquilo»: el barco amarrado con la linterna encendida (el chat sigue
// ahí), el taller a medio levantar (los equipos que faltan) y el alba que llega.
export function ChatCerrado() {
  const t = useT('chat');
  return (
    <div className="chat-cerrado">
      <picture className="chat-cerrado__lamina paisaje paisaje--noche" style={{ backgroundColor: '#443D3C' }} aria-hidden="true">
        <source type="image/avif" srcSet={srcSet('avif')} sizes="(max-width: 900px) 100vw, 860px" />
        <source type="image/webp" srcSet={srcSet('webp')} sizes="(max-width: 900px) 100vw, 860px" />
        <img src="/laminas/puerto-tranquilo-960.webp" width={1774} height={887} alt="" decoding="async" />
      </picture>
      <div className="chat-cerrado__cabeza">
        <p className="chat-hero__fecha">{t('cerradoEyebrow')}</p>
        <h2 className="chat-cerrado__titulo"><Enfasis texto={t('cerradoTitulo')} /></h2>
        <p className="chat-cerrado__texto">{t('cerradoTexto')}</p>
      </div>
      <ul className="chat-cerrado__accesos">
        {ACCESOS.map(({ to, icono: Icono, titulo, texto }) => (
          <li key={to}>
            <Link to={to} className="chat-cerrado__acceso">
              <Icono size={18} />
              <span className="chat-cerrado__acceso-titulo">{t(titulo)}</span>
              <span className="chat-cerrado__acceso-texto">{t(texto)}</span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="chat-cerrado__apoyo">
        <p><Enfasis texto={t('cerradoApoyoTexto')} /></p>
        <Link to="/donate" className="chat-cerrado__donar">
          <IconCorazon size={16} /> {t('cerradoApoyo')}
        </Link>
      </div>
    </div>
  );
}

// En una conversación abierta, el aviso ocupa el sitio de la caja de mensaje.
export function AvisoChatCerrado() {
  const t = useT('chat');
  return (
    <p className="chat-cerrado__aviso" role="status">
      {t('cerradoAviso')} <Link to="/remote">{t('accesoRemoto')} →</Link>
    </p>
  );
}
