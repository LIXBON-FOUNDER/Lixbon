import { useSeo } from '../lib/seo';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { Link } from '../i18n/link';
import { useT } from '../i18n/useT';
import { PublicNav } from '../components/PublicNav';
import { PublicFooter } from '../components/PublicFooter';
import { CodeBlock } from '../components/CodeBlock';
import { IconDownload, IconTerminal, IconCheck, IconPhone, IconChevron } from '../components/Icons';

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

const MAX_HISTORIAL_CLI = 8;

const ARCHIVOS_CLI = {
  windows: [['windows-amd64', 'Windows x64'], ['windows-arm64', 'Windows ARM64']],
  unix: [
    ['linux-amd64', 'Linux x64'], ['linux-arm64', 'Linux ARM64'],
    ['darwin-arm64', 'macOS Apple Silicon'], ['darwin-amd64', 'macOS Intel'],
  ],
};

function versionesCli(lista) {
  const porVersion = new Map();
  for (const fila of lista) {
    if (!String(fila.product || '').startsWith('cli-')) continue;
    const entrada = porVersion.get(fila.version) || {
      version: fila.version,
      channel: fila.channel,
      release_date: fila.release_date,
      changelog: Array.isArray(fila.changelog) ? fila.changelog : [],
      archivos: {},
    };
    if (fila.download_url && fila.checksum_sha256) {
      entrada.archivos[fila.product.slice('cli-'.length)] = { url: fila.download_url, sha256: fila.checksum_sha256 };
    }
    porVersion.set(fila.version, entrada);
  }
  return [...porVersion.values()].sort((a, b) => compararVersiones(b.version, a.version));
}

const nombreDeArchivo = (url) => url.slice(url.lastIndexOf('/') + 1);
const sumasDe = (url) => `${url.slice(0, url.lastIndexOf('/'))}/SHA256SUMS`;

function Nota({ texto }) {
  return String(texto).split('`').map((trozo, i) => (i % 2 ? <code key={i}>{trozo}</code> : trozo));
}

function EtapaCli({ channel, t }) {
  return (
    <span className={`dl-stage dl-stage--${channel === 'stable' ? 'stable' : 'beta'}`}>
      {channel === 'stable' ? t('stable') : t('beta')}
    </span>
  );
}

function HistorialCli({ versiones, t }) {
  return (
    <details className="dl-details" open>
      <summary>{t('cliHistory')}</summary>
      <ol className="dl-history">
        {versiones.map((v) => (
          <li key={v.version}>
            <div className="dl-history__head">
              <strong>v{v.version}</strong>
              <EtapaCli channel={v.channel} t={t} />
              <span className="dl-card__meta">{v.release_date}</span>
            </div>
            {v.changelog.length ? (
              <ul>{v.changelog.map((nota, i) => <li key={i}><Nota texto={nota} /></li>)}</ul>
            ) : (
              <p className="dl-card__note">{t('cliNoNotes')}</p>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

function InstalacionManualCli({ version, os, base, t }) {
  const archivos = ARCHIVOS_CLI[os].filter(([plataforma]) => version.archivos[plataforma]);
  if (!archivos.length) return null;
  const [primera] = archivos;
  const archivo = nombreDeArchivo(version.archivos[primera[0]].url);
  const comandos = os === 'windows'
    ? [
      `$f = "${archivo}"`,
      '(Get-FileHash $f -Algorithm SHA256).Hash.ToLower()',
      'Expand-Archive $f -DestinationPath "$env:TEMP\\lixbon-descarga" -Force',
      'New-Item -ItemType Directory -Force "$env:USERPROFILE\\.lixbon" | Out-Null',
      'Copy-Item "$env:TEMP\\lixbon-descarga\\*\\lixbon.exe" "$env:USERPROFILE\\.lixbon\\lixbon.exe" -Force',
      `& "$env:USERPROFILE\\.lixbon\\lixbon.exe" init --base-url ${base}/v1`,
    ]
    : [
      `f=${archivo}`,
      'sha256sum "$f"   # en macOS: shasum -a 256 "$f"',
      'tar -xzf "$f"',
      'mkdir -p ~/.local/bin && install -m 755 lixbon-*/lixbon ~/.local/bin/lixbon',
      `~/.local/bin/lixbon init --base-url ${base}/v1`,
    ];
  return (
    <details className="dl-details">
      <summary>{t('manualInstall')}</summary>
      <p className="dl-card__note">{t('manualIntro', { version: version.version })}</p>
      <ul className="dl-files">
        {archivos.map(([plataforma, nombre]) => {
          const { url, sha256 } = version.archivos[plataforma];
          return (
            <li key={plataforma}>
              <a href={url}>{nombre}</a>
              <code className="dl-files__sha" title="SHA-256">{sha256}</code>
            </li>
          );
        })}
      </ul>
      <p className="dl-card__note">
        <a href={sumasDe(version.archivos[primera[0]].url)}>SHA256SUMS</a> {t('manualSums')}
      </p>
      <p className="dl-card__note">{t('manualSteps')}</p>
      <CodeBlock code={comandos.join('\n')} label={os === 'windows' ? 'powershell' : 'bash'} />
      <p className="dl-card__note">{t('manualPath', { path: os === 'windows' ? '%USERPROFILE%\\.lixbon' : '~/.local/bin' })}</p>
    </details>
  );
}

const claveDe = (v) => `${v.version}@${v.channel}`;
// La recomendada es la primera estable; si aún no hay estable, la más nueva.
const recomendadaDe = (lista) => lista.find((v) => v.channel === 'stable') || lista[0];

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
  const [escritorioMac, setEscritorioMac] = useState(null);
  const [android, setAndroid] = useState(null);
  const [cli, setCli] = useState(null);
  const [os, setOs] = useState('windows');
  const [plataforma, setPlataforma] = useState('windows');

  const base = useMemo(() => (typeof window === 'undefined' ? 'https://lixbon.com' : window.location.origin), []);

  useEffect(() => {
    api.get('/api/versions')
      .then((res) => {
        const lista = Array.isArray(res.data) ? res.data : [];
        setEscritorio(versionesDe(lista, 'desktop'));
        setEscritorioMac(versionesDe(lista, 'desktop-mac'));
        setAndroid(versionesDe(lista, 'android'));
        setCli(versionesCli(lista));
      })
      .catch(() => { setEscritorio([]); setEscritorioMac([]); setAndroid([]); setCli([]); });
    if (/Mac|Linux|X11/.test(navigator.platform) && !/Win/.test(navigator.platform)) {
      setOs('unix');
    }
    if (/Mac/.test(navigator.platform)) setPlataforma('mac');
  }, []);

  const winCmd = `irm ${base}/install.ps1 | iex`;
  const unixCmd = `curl -fsSL ${base}/install.sh | bash`;
  // Es la que instalan los comandos: la última estable y, sin estables, la última beta.
  const cliRecomendada = cli?.length ? recomendadaDe(cli) : null;

  return (
    <div className="page web">
      <PublicNav />
      <main className="page__body page__body--wide">
        <h1 className="page__title page__title--center">{t('title')}</h1>
        <p className="plans__sub">{t('subtitle')}</p>

        <div className="downloads">
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
                <div className="os-tabs dl-card__plataformas" role="tablist" aria-label={t('platform')}>
                  <button
                    role="tab" aria-selected={plataforma === 'windows'}
                    className={`os-tab ${plataforma === 'windows' ? 'is-active' : ''}`}
                    onClick={() => setPlataforma('windows')}
                  >
                    Windows
                  </button>
                  <button
                    role="tab" aria-selected={plataforma === 'mac'}
                    className={`os-tab ${plataforma === 'mac' ? 'is-active' : ''}`}
                    onClick={() => setPlataforma('mac')}
                  >
                    macOS
                  </button>
                </div>
                {plataforma === 'mac' ? (
                  <>
                    <SelectorVersion key="mac" versiones={escritorioMac} producto="desktop-mac" requisitos={t('macRequirements')} t={t} />
                    {!!escritorioMac?.length && <span className="dl-card__meta">{t('macUnsigned')}</span>}
                  </>
                ) : (
                  <SelectorVersion key="win" versiones={escritorio} producto="desktop" requisitos="Windows 10/11 (64 bits)" t={t} />
                )}
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

            {cliRecomendada && (
              <div className="dl-cli-meta">
                <span className="dl-card__meta">v{cliRecomendada.version}</span>
                <EtapaCli channel={cliRecomendada.channel} t={t} />
                <span className="dl-card__meta">{cliRecomendada.release_date}</span>
              </div>
            )}
            {cliRecomendada?.channel === 'beta' && <p className="dl-card__note">{t('cliBetaNote')}</p>}

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
                  {t('noteUnix', { cmd: 'lixbon', bin: '~/.local/bin' })}
                </p>
              </>
            )}

            <p className="dl-card__step">{t('step2')}</p>
            <CodeBlock code={`lixbon`} />

            <p className="dl-card__step">{t('step3')}</p>
            <CodeBlock code={`lixbon update`} />
            <p className="dl-card__note">{t('cliUpdateNote')}</p>

            {!!cli?.length && <HistorialCli versiones={cli.slice(0, MAX_HISTORIAL_CLI)} t={t} />}
            {cliRecomendada && <InstalacionManualCli version={cliRecomendada} os={os} base={base} t={t} />}
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
