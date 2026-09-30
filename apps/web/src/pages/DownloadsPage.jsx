// DownloadsPage.jsx — descargas públicas (/apps): app de escritorio,
// app de Android y CLI. Escritorio y Android van como dos cuadros iguales;
// el CLI se instala con un comando (PowerShell en Windows, bash en
// Linux/macOS) que baja e instala client_cli.py y crea el lanzador `lixbon`.
import { useSeo } from '../lib/seo';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { Link } from '../i18n/link';
import { useT } from '../i18n/useT';
import { PublicNav } from '../components/PublicNav';
import { PublicFooter } from '../components/PublicFooter';
import { CodeBlock } from '../components/CodeBlock';
import { IconDownload, IconTerminal, IconCheck, IconPhone, IconChevron } from '../components/Icons';

// Solo la última y la penúltima versión publicada de cada app: el selector
// no tiene que cargar con todo el historial.
const MAX_VERSIONES = 2;

// «1.4.0-beta.2» → [1, 4, 0] y su prerelease; una versión final va por
// delante de sus betas.
function compararVersiones(a, b) {
  const [na, pa = ''] = String(a).split('-', 2);
  const [nb, pb = ''] = String(b).split('-', 2);
  const xa = na.split('.').map((n) => parseInt(n, 10) || 0);
  const xb = nb.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(xa.length, xb.length); i += 1) {
    if ((xa[i] || 0) !== (xb[i] || 0)) return (xa[i] || 0) - (xb[i] || 0);
  }
  if (pa === pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  return pa.localeCompare(pb, undefined, { numeric: true });
}

// Las versiones de un producto, de la más nueva a la más vieja, sin repetir.
function versionesDe(lista, producto) {
  const vistas = new Set();
  return lista
    .filter((v) => (v.product || 'desktop') === producto)
    .sort((a, b) => compararVersiones(b.version, a.version)
      || String(b.release_date || '').localeCompare(String(a.release_date || '')))
    .filter((v) => {
      const k = `${v.version}@${v.channel}`;
      if (vistas.has(k)) return false;
      vistas.add(k);
      return true;
    })
    .slice(0, MAX_VERSIONES);
}

const claveDe = (v) => `${v.version}@${v.channel}`;
// La recomendada es la primera estable; si aún no hay estable, la más nueva.
const recomendadaDe = (lista) => lista.find((v) => v.channel === 'stable') || lista[0];

/** Selector de versión + descarga, igual para escritorio y Android. */
function SelectorVersion({ versiones, producto, requisitos, t }) {
  const [elegida, setElegida] = useState('');
  const recomendada = versiones?.length ? recomendadaDe(versiones) : null;
  const clave = elegida || (recomendada ? claveDe(recomendada) : '');
  const sel = versiones?.find((v) => claveDe(v) === clave);

  if (versiones === null) return <span className="dl-card__meta">{t('loading')}</span>;
  if (!versiones.length) {
    return <span className="pill-btn pill-btn--outline dl-card__cta is-soon">{t('comingSoon')}</span>;
  }
  const url = sel
    ? `/api/updates/download/${encodeURIComponent(sel.version)}/${sel.channel}${producto === 'desktop' ? '' : `?product=${producto}`}`
    : '';
  return (
    <>
      <div className="dl-picker">
        <label className="dl-picker__select">
          <select aria-label={t('version')} value={clave} onChange={(e) => setElegida(e.target.value)}>
            {versiones.map((v) => (
              <option key={claveDe(v)} value={claveDe(v)}>
                v{v.version} · {v.channel === 'stable' ? t('stable') : t('beta')}{v === recomendada ? ` · ${t('recommended')}` : ''}
              </option>
            ))}
          </select>
          <IconChevron size={14} />
        </label>
        {sel && (
          <a href={url} className="pill-btn pill-btn--primary dl-card__cta">
            <IconDownload size={16} /> {t('download')}
          </a>
        )}
      </div>
      {sel && (
        <span className="dl-card__meta">
          {sel.release_date} · {requisitos}
          {sel.channel !== 'stable' && ` · ${t('betaNote')}`}
        </span>
      )}
    </>
  );
}

export default function DownloadsPage() {
  const t = useT('downloads');
  useSeo({ title: t('seoTitle'), description: t('seoDescription'), path: '/apps' });
  const [escritorio, setEscritorio] = useState(null);
  const [android, setAndroid] = useState(null);
  const [os, setOs] = useState('windows');

  // Origen del gateway (para los comandos de instalación del CLI)
  const base = useMemo(() => (typeof window === 'undefined' ? 'https://lixbon.com' : window.location.origin), []);

  useEffect(() => {
    api.get('/api/versions')
      .then((res) => {
        const lista = Array.isArray(res.data) ? res.data : [];
        setEscritorio(versionesDe(lista, 'desktop'));
        setAndroid(versionesDe(lista, 'android'));
      })
      .catch(() => { setEscritorio([]); setAndroid([]); });
    if (/Mac|Linux|X11/.test(navigator.platform) && !/Win/.test(navigator.platform)) {
      setOs('unix');
    }
  }, []);

  const winCmd = `irm ${base}/install.ps1 | iex`;
  const unixCmd = `curl -fsSL ${base}/install.sh | bash`;

  return (
    <div className="page">
      <PublicNav />
      <main className="page__body page__body--wide">
        <h1 className="page__title page__title--center">{t('title')}</h1>
        <p className="plans__sub">{t('subtitle')}</p>

        <div className="downloads">
          {/* ── Apps: escritorio + Android, dos cuadros iguales ── */}
          <div className="downloads__apps">
            <section className="dl-card dl-card--app">
              <div className="dl-card__head">
                <img src="/favicon.svg" alt="" className="dl-card__logo" draggable={false} />
                <div className="dl-card__heading">
                  <h2 className="dl-card__title">{t('desktopTitle')}</h2>
                  <p className="dl-card__desc">{t('desktopDesc')}</p>
                </div>
              </div>
              <ul className="dl-card__features">
                <li><IconCheck size={15} /> {t('desktopFeature1')}</li>
                <li><IconCheck size={15} /> {t('desktopFeature2')}</li>
                <li><IconCheck size={15} /> {t('desktopFeature3')}</li>
              </ul>
              <div className="dl-card__bottom">
                <SelectorVersion versiones={escritorio} producto="desktop" requisitos="Windows 10/11 (64 bits)" t={t} />
              </div>
            </section>

            <section className="dl-card dl-card--android">
              <div className="dl-card__head">
                <div className="dl-card__icon"><IconPhone size={19} /></div>
                <div className="dl-card__heading">
                  <h2 className="dl-card__title">{t('androidTitle')}</h2>
                  <p className="dl-card__desc">{t('androidDesc')}</p>
                </div>
              </div>
              <ul className="dl-card__features">
                <li><IconCheck size={15} /> {t('androidFeature1')}</li>
                <li><IconCheck size={15} /> {t('androidFeature2')}</li>
                <li><IconCheck size={15} /> {t('androidFeature3')}</li>
              </ul>
              <div className="dl-card__bottom">
                <SelectorVersion versiones={android} producto="android" requisitos="APK · Android 7.0+" t={t} />
              </div>
            </section>
          </div>

          {/* ── CLI ── */}
          <section className="dl-card dl-card--cli">
            <div className="dl-card__head">
              <div className="dl-card__icon"><IconTerminal size={19} /></div>
              <div className="dl-card__heading">
                <h2 className="dl-card__title">{t('cliTitle')}</h2>
                <p className="dl-card__desc">{t('cliDesc')}</p>
              </div>
              <div className="os-tabs" role="tablist">
              <button
                role="tab" aria-selected={os === 'windows'}
                className={`os-tab ${os === 'windows' ? 'is-active' : ''}`}
                onClick={() => setOs('windows')}
              >
                Windows
              </button>
              <button
                role="tab" aria-selected={os === 'unix'}
                className={`os-tab ${os === 'unix' ? 'is-active' : ''}`}
                onClick={() => setOs('unix')}
              >
                Linux / macOS
                </button>
              </div>
            </div>

            {os === 'windows' ? (
              <>
                <p className="dl-card__step">{t('step1Win')} <strong>PowerShell</strong> {t('step1WinRest')}</p>
                <CodeBlock code={winCmd} label="powershell" />
                <p className="dl-card__note">
                  {t('noteWin', { path: '%USERPROFILE%\\.lixbon', cmd: 'lixbon' })}
                </p>
              </>
            ) : (
              <>
                <p className="dl-card__step">{t('step1Unix')} <strong>terminal</strong> {t('step1UnixRest')}</p>
                <CodeBlock code={unixCmd} label="bash" />
                <p className="dl-card__note">
                  {t('noteUnix', { home: '~/.lixbon', cmd: 'lixbon', bin: '~/.local/bin' })}
                </p>
              </>
            )}

            <p className="dl-card__step">{t('step2')}</p>
            <CodeBlock code={`lixbon`} />

            <details className="dl-details">
              <summary>{t('manualInstall')}</summary>
              <p className="dl-card__note">
                {t('manualNote')} <a href={`${base}/install/client_cli.py`}>client_cli.py</a> {t('manualNoteRest')}
              </p>
              <CodeBlock code={`python client_cli.py init --base-url ${base}/v1`} />
              <CodeBlock code={`python client_cli.py chat`} />
            </details>
          </section>
        </div>

        <p className="downloads__foot">
          {t('footPrompt')} <Link to="/docs">{t('footLink')}</Link>.
        </p>
      </main>
      <PublicFooter />
    </div>
  );
}
