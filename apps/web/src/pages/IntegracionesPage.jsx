import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSeo } from '../lib/seo';
import { Link } from '../i18n/link';
import { useT } from '../i18n/useT';
import { useAuth } from '../hooks/useAuth';
import { useShell } from '../components/AppShell';
import { Icono, IconMenu, IconSearch, IconDownload, IconNext, IconX, IconExternal } from '../components/Icons';
import { downloadSkill, listSkills } from '../lib/skillsApi';
import { LogoMarca } from '../components/LogosMarcas';
import { useConfirmar } from '../hooks/useConfirmar';
import { desconectarGithub, estadoGithub, estadoGithubConocido } from '../lib/github';
import { ConectarGithub } from '../components/ConectarGithub';
import '../styles/github.css';

const AVISOS_GITHUB = ['connected', 'installed', 'requested', 'cancelled', 'error', 'session', 'expired'];

// Conectores: los incluidos ya funcionan en el chat; los «pronto» aún no tienen
// backend y se muestran sin acción. GitHub pasa a «disponible» cuando el
// servidor tiene la App configurada.
// Se listan por categoría; dentro de cada una, lo que ya funciona va primero
// y lo que llegará («Pronto») al final y atenuado.
const CATEGORIAS = ['lixbon', 'desarrollo', 'google', 'microsoft', 'redes', 'comunicacion', 'productividad', 'comercio'];
const CONECTORES = [
  { id: 'web', icono: 'globo', estado: 'incluido', cat: 'lixbon' },
  { id: 'visuals', icono: 'visuals', estado: 'incluido', to: '/visuals', cat: 'lixbon' },
  { id: 'docs', icono: 'archivo', estado: 'incluido', cat: 'lixbon' },
  { id: 'vision', icono: 'imagen', estado: 'incluido', cat: 'lixbon' },
  { id: 'github', marca: true, estado: 'pronto', cat: 'desarrollo' },
  { id: 'mcp', icono: 'nodos', estado: 'disponible', to: '/account/mcp', cat: 'desarrollo' },
  // Nuevos «Pronto» (investigados el 2026-11-03): API pública con OAuth o bot y
  // términos que permiten a un tercero actuar por el usuario. Fuera por ahora:
  // WhatsApp (programa Tech Provider + verificación de empresa) y TikTok (sin
  // auditoría solo publica en privado).
  { id: 'linear', marca: true, estado: 'pronto', cat: 'desarrollo' },
  { id: 'jira', marca: true, estado: 'pronto', cat: 'desarrollo' },
  { id: 'confluence', marca: true, estado: 'pronto', cat: 'desarrollo' },
  { id: 'outlook', marca: true, estado: 'pronto', cat: 'microsoft' },
  { id: 'onedrive', marca: true, estado: 'pronto', cat: 'microsoft' },
  { id: 'instagram', marca: true, estado: 'pronto', cat: 'redes' },
  { id: 'linkedin', marca: true, estado: 'pronto', cat: 'redes' },
  { id: 'x', marca: true, estado: 'pronto', cat: 'redes' },
  { id: 'discord', marca: true, estado: 'pronto', cat: 'comunicacion' },
  { id: 'telegram', marca: true, estado: 'pronto', cat: 'comunicacion' },
  { id: 'shopify', marca: true, estado: 'pronto', cat: 'comercio' },
  { id: 'gmail', marca: true, estado: 'pronto', cat: 'google' },
  { id: 'drive', marca: true, estado: 'pronto', cat: 'google' },
  { id: 'calendar', marca: true, estado: 'pronto', cat: 'google' },
  { id: 'slack', marca: true, estado: 'pronto', cat: 'comunicacion' },
  { id: 'notion', marca: true, estado: 'pronto', cat: 'productividad' },
];
const ORDEN_ESTADO = { incluido: 0, disponible: 0, pronto: 1 };

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function Grupo({ titulo, children }) {
  return (
    <section className="int-grupo">
      <h2 className="int-grupo__titulo">{titulo}</h2>
      <div className="int-lista">{children}</div>
    </section>
  );
}

// `activa`: conectada, incluida o instalada. Lleva un sello verde en el logo
// para distinguirla de un vistazo de lo que aún no tiene.
function Fila({ marca, nombre, texto, accion, apagada, activa = false, etiquetaActiva = '' }) {
  return (
    <div className={`int-fila ${apagada ? 'is-apagada' : ''} ${activa ? 'is-activa' : ''}`}>
      <span className="int-fila__marca">
        {marca}
        {activa && <span className="int-fila__sello" role="img" aria-label={etiquetaActiva} title={etiquetaActiva}><Icono nombre="hecho" size={10} /></span>}
      </span>
      <span className="int-fila__texto">
        <strong>{nombre}</strong>
        <span>{texto}</span>
      </span>
      <span className="int-fila__accion">{accion}</span>
    </div>
  );
}

// Cada usuario conecta SU cuenta de GitHub; desde aquí la administra o la quita.
function AccionGithub({ estado, onCambio }) {
  const tg = useT('github');
  const confirmar = useConfirmar();
  const [ocupado, setOcupado] = useState(false);
  const [conectar, setConectar] = useState(false);
  if (!estado.connected) {
    return (
      <>
        <button type="button" className="pill-btn pill-btn--primary" onClick={() => setConectar(true)}>
          {tg('connect')}
        </button>
        {conectar && <ConectarGithub onClose={() => setConectar(false)} />}
      </>
    );
  }
  const quitar = async () => {
    const ok = await confirmar({ titulo: tg('disconnectTitle'), texto: tg('disconnectText'), etiqueta: tg('disconnect') });
    if (!ok) return;
    setOcupado(true);
    try {
      await desconectarGithub();
      onCambio();
    } finally { setOcupado(false); }
  };
  return (
    <span className="int-acciones">
      {estado.manage_url && (
        <a className="icon-btn" href={estado.manage_url} target="_blank" rel="noreferrer"
          aria-label={tg('manage')} title={tg('manage')}><IconExternal size={16} /></a>
      )}
      <button type="button" className="pill-btn" onClick={quitar} disabled={ocupado}>{tg('disconnect')}</button>
    </span>
  );
}

function Conectores({ t, q, github, onGithub }) {
  const tg = useT('github');
  // Mientras llega el estado, GitHub va en «Disponibles» (lo normal con el
  // conector configurado): antes saltaba de «Próximamente» a «Disponibles».
  const catalogo = CONECTORES.map((c) => (c.id === 'github' && (github === undefined || github?.configured)
    ? { ...c, estado: 'disponible' } : c));
  const lista = catalogo.filter((c) => !q || norm(`${t(`c_${c.id}`)} ${t(`c_${c.id}_d`)}`).includes(q));
  if (!lista.length) return <p className="int-vacio">{t('noResults')}</p>;
  return CATEGORIAS.map((cat) => {
    const items = lista.filter((c) => c.cat === cat)
      .sort((a, b) => ORDEN_ESTADO[a.estado] - ORDEN_ESTADO[b.estado]);
    if (!items.length) return null;
    return (
      <Grupo key={cat} titulo={t(`cat_${cat}`)}>
        {items.map((c) => (
          <Fila
            key={c.id}
            apagada={c.estado === 'pronto'}
            activa={c.estado === 'incluido' || (c.id === 'github' && !!github?.connected)}
            etiquetaActiva={c.estado === 'incluido' ? t('activeIncluded') : t('activeConnected')}
            marca={c.icono ? <Icono nombre={c.icono} size={18} /> : <LogoMarca id={c.id} size={20} />}
            nombre={t(`c_${c.id}`)}
            texto={c.id === 'github' && github?.connected ? tg('connected', { login: github.login }) : t(`c_${c.id}_d`)}
            accion={c.estado === 'pronto' ? <span className="int-etiqueta">{t('soonTag')}</span>
              : c.id === 'github' ? (github ? <AccionGithub estado={github} onCambio={onGithub} /> : null)
              : c.to ? <Link to={c.to} className="icon-btn" aria-label={c.estado === 'incluido' ? t('open') : t('configure')} title={c.estado === 'incluido' ? t('open') : t('configure')}><IconNext size={16} /></Link>
                : null}
          />
        ))}
      </Grupo>
    );
  });
}

function Habilidades({ t, q, user }) {
  const [skills, setSkills] = useState(undefined);
  const [cat, setCat] = useState('');
  const [bajando, setBajando] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    listSkills().then(setSkills).catch(() => setSkills(null));
  }, [user]);

  const categorias = useMemo(() => [...new Set((skills || []).map((s) => s.category).filter(Boolean))], [skills]);

  if (skills === undefined) return <p className="int-vacio">{t('loading')}</p>;
  if (skills === null) return <p className="int-vacio">{t('loadError')}</p>;
  if (!skills.length) return <p className="int-vacio">{t('noSkills')}</p>;

  const lista = skills.filter((s) => (!cat || s.category === cat)
    && (!q || norm(`${s.title} ${s.command} ${s.summary} ${s.category}`).includes(q)));

  const descargar = async (slug) => {
    setBajando(slug);
    setError('');
    try { await downloadSkill(slug); } catch { setError(slug); } finally { setBajando(''); }
  };

  const fila = (s) => (
    <Fila
      key={s.slug}
      activa={!!s.installed_by_me}
      etiquetaActiva={t('activeInstalled')}
      marca={<Icono nombre="skills" size={18} />}
      nombre={<>{s.title} <code className="int-cmd">{s.command}</code></>}
      texto={error === s.slug ? t('downloadError') : s.summary}
      accion={user ? (
        <button type="button" className="icon-btn" onClick={() => descargar(s.slug)} disabled={bajando === s.slug}
          aria-label={bajando === s.slug ? t('downloading') : t('download')} title={t('download')}>
          <IconDownload size={16} />
        </button>
      ) : <Link to="/auth?next=/integraciones?tab=skills" className="int-etiqueta">{t('loginToDownload')}</Link>}
    />
  );

  const instaladas = lista.filter((s) => s.installed_by_me);
  const resto = lista.filter((s) => !s.installed_by_me);
  return (
    <>
      {categorias.length > 1 && (
        <div className="int-chips" role="group">
          {['', ...categorias].map((c) => (
            <button key={c || 'all'} type="button" className={cat === c ? 'is-on' : ''} aria-pressed={cat === c} onClick={() => setCat(c)}>
              {c || t('all')}
            </button>
          ))}
        </div>
      )}
      {!lista.length && <p className="int-vacio">{t('noResults')}</p>}
      {instaladas.length > 0 && <Grupo titulo={t('installed')}>{instaladas.map(fila)}</Grupo>}
      {resto.length > 0 && <Grupo titulo={instaladas.length ? t('available') : t('all')}>{resto.map(fila)}</Grupo>}
      <p className="int-pie">{t('installHint')}</p>
    </>
  );
}

export default function IntegracionesPage() {
  const t = useT('integraciones');
  const tch = useT('chat');
  useSeo({ title: t('seoTitle'), noindex: true });
  const { user, loading: cargandoSesion } = useAuth();
  const { openDrawer, drawerOpen } = useShell();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'skills' ? 'skills' : 'connectors';
  const [busca, setBusca] = useState('');
  const q = norm(busca.trim());
  const tg = useT('github');
  // undefined = aún no se sabe (se pinta en «Disponibles» sin acción); null = sin sesión o error.
  const [github, setGithub] = useState(estadoGithubConocido);
  // Vuelta de GitHub tras conectar o instalar: ?github=connected|installed|cancelled|…
  const avisoGithub = params.get('github');
  const cargarGithub = () => {
    if (cargandoSesion) return; // sin esto, «sin sesión» un instante lo mandaba a Próximamente
    if (!user) { setGithub(null); return; }
    estadoGithub({ fresco: true }).then(setGithub).catch(() => setGithub(null));
  };
  useEffect(cargarGithub, [user, cargandoSesion]); // eslint-disable-line react-hooks/exhaustive-deps

  const cambiar = (nuevo) => {
    setBusca('');
    setParams(nuevo === 'skills' ? { tab: 'skills' } : {}, { replace: true });
  };

  return (
    <section className="chat-main int-page">
      <header className="chat-header int-cab">
        <button className="icon-btn chat-header__menu" onClick={openDrawer} aria-label={tch('openConversationsPanel')}
          aria-controls="sidebar-drawer" aria-expanded={drawerOpen}>
          <IconMenu />
        </button>
        <span className="int-tabs" role="tablist">
          {[['connectors', t('tabConnectors')], ['skills', t('tabSkills')]].map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-on' : ''} onClick={() => cambiar(id)}>
              {label}
            </button>
          ))}
        </span>
      </header>

      <div className="int-cuerpo">
        <div className="int-col">
          <h1 className="int-titulo">{tab === 'skills' ? t('skillsTitle') : t('connectorsTitle')}</h1>
          <p className="int-sub">{tab === 'skills' ? t('skillsSub') : t('connectorsSub')}</p>
          <label className="int-buscar">
            <IconSearch size={16} />
            <input value={busca} onChange={(e) => setBusca(e.target.value)}
              placeholder={tab === 'skills' ? t('searchSkills') : t('searchConnectors')}
              aria-label={tab === 'skills' ? t('searchSkills') : t('searchConnectors')} />
            {busca && <button type="button" className="int-buscar__x" onClick={() => setBusca('')} aria-label="×"><IconX size={14} /></button>}
          </label>
          {AVISOS_GITHUB.includes(avisoGithub) && tab !== 'skills' && (
            <p className="int-aviso" role="status">{tg(`status_${avisoGithub}`)}</p>
          )}
          {tab === 'skills' ? <Habilidades t={t} q={q} user={user} /> : <Conectores t={t} q={q} github={github} onGithub={cargarGithub} />}
        </div>
      </div>
    </section>
  );
}
