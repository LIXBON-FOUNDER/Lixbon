// SkillsPage.jsx — catálogo público de skills (/skills) y su ficha (/skills/:slug).
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useSeo } from '../lib/seo';
import { Link } from '../i18n/link';
import { useT } from '../i18n/useT';
import { useAuth } from '../hooks/useAuth';
import { PublicNav } from '../components/PublicNav';
import { PublicFooter } from '../components/PublicFooter';
import { Markdown } from '../components/Markdown';
import { IconArrowLeft, IconDownload } from '../components/Icons';
import { downloadSkill, fmtPeso, getSkill, listSkills, rateSkill } from '../lib/skillsApi';

const fecha = (iso, loc) => (iso
  ? new Date(iso).toLocaleDateString(loc, { day: 'numeric', month: 'long', year: 'numeric' }) : '');

function Estrellas({ valor, tam = 14 }) {
  const lleno = Math.round((valor || 0) * 2) / 2;
  return (
    <span className="sk-stars" style={{ '--sk-star': `${tam}px` }} aria-hidden="true">
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={`sk-star ${lleno >= i ? 'is-on' : lleno >= i - 0.5 ? 'is-half' : ''}`}>★</span>
      ))}
    </span>
  );
}

export function Calificacion({ skill, t }) {
  if (!skill.rating_count) return <span className="sk-rating sk-rating--none">{t('noVotes')}</span>;
  return (
    <span className="sk-rating" title={skill.rating_avg.toFixed(2)}>
      <Estrellas valor={skill.rating_avg} />
      <strong>{skill.rating_avg.toFixed(1)}</strong>
      <span>{t('votes')(skill.rating_count)}</span>
    </span>
  );
}

function Tarjeta({ skill, t }) {
  return (
    <Link to={`/skills/${skill.slug}`} className="sk-card">
      <div className="sk-card__top">
        <span className="sk-cmd">{skill.command}</span>
        {skill.category && <span className="sk-chip">{skill.category}</span>}
      </div>
      <h2 className="sk-card__title">{skill.title}</h2>
      <p className="sk-card__summary">{skill.summary}</p>
      <div className="sk-card__foot">
        <Calificacion skill={skill} t={t} />
        <span className="sk-ver">v{skill.version}</span>
      </div>
    </Link>
  );
}

function Votar({ skill, onChange, t }) {
  const [hover, setHover] = useState(0);
  const [error, setError] = useState('');
  const puede = skill.installed_by_me || skill.my_rating;
  const votar = async (stars) => {
    setError('');
    try {
      onChange(await rateSkill(skill.slug, stars));
    } catch {
      setError(t('rateError'));
    }
  };
  if (!puede) return <p className="sk-hint">{t('rateHint')}</p>;
  const actual = hover || skill.my_rating || 0;
  return (
    <div className="sk-vote">
      <span className="sk-label">{t('yourRating')}</span>
      <div className="sk-vote__stars" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((i) => (
          <button key={i} type="button" className={`sk-star ${actual >= i ? 'is-on' : ''}`}
            aria-label={t('star')(i)} aria-pressed={skill.my_rating === i}
            onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(0)}
            onClick={() => votar(i)}>★</button>
        ))}
      </div>
      {skill.my_rating && <button type="button" className="sk-link" onClick={() => votar(null)}>{t('removeRating')}</button>}
      {error && <p className="sk-error">{error}</p>}
    </div>
  );
}

function Ficha({ slug, t }) {
  const { user } = useAuth();
  const [skill, setSkill] = useState(undefined);
  const [bajando, setBajando] = useState(false);
  const [error, setError] = useState('');
  useSeo({ title: skill ? `/${skill.slug} · ${skill.title}` : t('seoTitle'), description: skill?.summary,
    path: `/skills/${slug}` });

  useEffect(() => {
    setSkill(undefined);
    getSkill(slug).then(setSkill).catch(() => setSkill(null));
  }, [slug, user]);

  const descargar = async () => {
    setBajando(true);
    setError('');
    try {
      await downloadSkill(slug);
      setSkill(await getSkill(slug));
    } catch {
      setError(t('downloadError'));
    } finally {
      setBajando(false);
    }
  };

  if (skill === undefined) return <p className="releases__empty">{t('loading')}</p>;
  if (skill === null) return <p className="releases__empty">{t('notFound')}</p>;
  const loc = t('dateLocale');
  return (
    <article className="sk-detail">
      <Link to="/skills" className="sk-back"><IconArrowLeft size={15} /> {t('back')}</Link>
      <header className="sk-detail__head">
        <div>
          <span className="sk-cmd sk-cmd--lg">{skill.command}</span>
          <h1 className="sk-detail__title">{skill.title}</h1>
          <p className="sk-detail__summary">{skill.summary}</p>
          <div className="sk-meta">
            <Calificacion skill={skill} t={t} />
            <span>{t('version')} <strong className="mono">{skill.version}</strong></span>
            <span>{t('updated')} {fecha(skill.released_at, loc)}</span>
            <span>{t('installs')(skill.installs)}</span>
          </div>
        </div>
        <div className="sk-install">
          {user ? (
            <button type="button" className="pill-btn pill-btn--primary" onClick={descargar} disabled={bajando}>
              <IconDownload size={16} /> {bajando ? t('downloading') : t('download')}
            </button>
          ) : (
            <Link to="/auth" className="pill-btn pill-btn--primary">{t('loginToDownload')}</Link>
          )}
          {error && <p className="sk-error">{error}</p>}
          <p className="sk-hint">{t('installIde')}</p>
          <p className="sk-hint">{t('installManual')}</p>
        </div>
      </header>

      <div className="sk-detail__grid">
        <div className="sk-detail__body">
          {skill.description_md ? <Markdown>{skill.description_md}</Markdown> : <p>{skill.summary}</p>}
        </div>
        <aside className="sk-detail__side">
          {user && <section className="sk-box"><Votar skill={skill} t={t}
            onChange={(stats) => setSkill((s) => ({ ...s, ...stats }))} /></section>}
          <section className="sk-box">
            <h2 className="sk-box__title">{t('history')}</h2>
            <ol className="sk-versions">
              {skill.versions.map((v) => (
                <li key={v.version}>
                  <div className="sk-versions__head">
                    <span className="sk-ver">v{v.version}</span>
                    <span className="sk-hint">{fecha(v.released_at, loc)}</span>
                  </div>
                  {v.changelog && <p className="sk-versions__log">{v.changelog}</p>}
                </li>
              ))}
            </ol>
          </section>
          <section className="sk-box">
            <h2 className="sk-box__title">{t('contents')}</h2>
            <ul className="sk-files">
              {skill.files.map((f) => (
                <li key={f.path}><span className="mono">{f.path}</span><span>{fmtPeso(f.size)}</span></li>
              ))}
            </ul>
            <p className="sk-label">{t('checksum')}</p>
            <code className="sk-sha">{skill.sha256}</code>
          </section>
        </aside>
      </div>
    </article>
  );
}

function Catalogo({ t }) {
  const [skills, setSkills] = useState(null);
  const [error, setError] = useState(false);
  useSeo({ title: t('seoTitle'), description: t('seoDescription'), path: '/skills' });
  useEffect(() => {
    listSkills().then(setSkills).catch(() => { setSkills([]); setError(true); });
  }, []);
  return (
    <>
      <h1 className="page__title page__title--center">{t('seoTitle')}</h1>
      <p className="plans__sub">{t('subtitle')}</p>
      {skills === null ? <p className="releases__empty">{t('loading')}</p>
        : skills.length === 0 ? <p className="releases__empty">{error ? t('loadError') : t('empty')}</p>
          : <div className="sk-grid">{skills.map((s) => <Tarjeta key={s.slug} skill={s} t={t} />)}</div>}
    </>
  );
}

export default function SkillsPage() {
  const t = useT('skills');
  const { slug } = useParams();
  return (
    <div className="page">
      <PublicNav />
      <main className="page__body page__body--wide">
        {slug ? <Ficha slug={slug} t={t} /> : <Catalogo t={t} />}
      </main>
      <PublicFooter />
    </div>
  );
}
