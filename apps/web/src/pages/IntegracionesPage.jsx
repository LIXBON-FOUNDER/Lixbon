import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSeo } from '../lib/seo';
import { Link } from '../i18n/link';
import { useT } from '../i18n/useT';
import { useAuth } from '../hooks/useAuth';
import { useShell } from '../components/AppShell';
import { Icono, IconMenu, IconSearch, IconDownload, IconNext, IconX } from '../components/Icons';
import { downloadSkill, listSkills } from '../lib/skillsApi';
import { LogoMarca } from '../components/LogosMarcas';

// Conectores: los incluidos ya funcionan en el chat; los «pronto» aún no tienen
// backend y se muestran sin acción.
const CONECTORES = [
  { id: 'web', icono: 'globo', estado: 'incluido' },
  { id: 'visuals', icono: 'visuals', estado: 'incluido', to: '/visuals' },
  { id: 'docs', icono: 'archivo', estado: 'incluido' },
  { id: 'vision', icono: 'imagen', estado: 'incluido' },
  { id: 'mcp', icono: 'nodos', estado: 'disponible', to: '/account/mcp' },
  { id: 'github', marca: true, estado: 'pronto' },
  { id: 'gmail', marca: true, estado: 'pronto' },
  { id: 'drive', marca: true, estado: 'pronto' },
  { id: 'notion', marca: true, estado: 'pronto' },
  { id: 'slack', marca: true, estado: 'pronto' },
  { id: 'calendar', marca: true, estado: 'pronto' },
];

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function Grupo({ titulo, children }) {
  return (
    <section className="int-grupo">
      <h2 className="int-grupo__titulo">{titulo}</h2>
      <div className="int-lista">{children}</div>
    </section>
  );
}

function Fila({ marca, nombre, texto, accion, apagada }) {
  return (
    <div className={`int-fila ${apagada ? 'is-apagada' : ''}`}>
      <span className="int-fila__marca">{marca}</span>
      <span className="int-fila__texto">
        <strong>{nombre}</strong>
        <span>{texto}</span>
      </span>
      <span className="int-fila__accion">{accion}</span>
    </div>
  );
}

function Conectores({ t, q }) {
  const lista = CONECTORES.filter((c) => !q || norm(`${t(`c_${c.id}`)} ${t(`c_${c.id}_d`)}`).includes(q));
  if (!lista.length) return <p className="int-vacio">{t('noResults')}</p>;
  const grupos = [['incluido', t('included')], ['disponible', t('available')], ['pronto', t('soon')]];
  return grupos.map(([estado, titulo]) => {
    const items = lista.filter((c) => c.estado === estado);
    if (!items.length) return null;
    return (
      <Grupo key={estado} titulo={titulo}>
        {items.map((c) => (
          <Fila
            key={c.id}
            apagada={c.estado === 'pronto'}
            marca={c.icono ? <Icono nombre={c.icono} size={18} /> : <LogoMarca id={c.id} size={20} />}
            nombre={t(`c_${c.id}`)}
            texto={t(`c_${c.id}_d`)}
            accion={c.estado === 'pronto' ? <span className="int-etiqueta">{t('soonTag')}</span>
              : c.to ? <Link to={c.to} className="icon-btn" aria-label={c.estado === 'incluido' ? t('open') : t('configure')} title={c.estado === 'incluido' ? t('open') : t('configure')}><IconNext size={16} /></Link>
                : <span className="int-etiqueta">{t('includedTag')}</span>}
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
  const { user } = useAuth();
  const { openDrawer, drawerOpen } = useShell();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'skills' ? 'skills' : 'connectors';
  const [busca, setBusca] = useState('');
  const q = norm(busca.trim());

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
          {tab === 'skills' ? <Habilidades t={t} q={q} user={user} /> : <Conectores t={t} q={q} />}
        </div>
      </div>
    </section>
  );
}
