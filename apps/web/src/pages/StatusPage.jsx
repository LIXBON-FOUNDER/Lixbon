// StatusPage.jsx — estado público de los servicios (/status): estado vivo de
// cada componente, disponibilidad de 90 días e incidentes. Se refresca solo.
import { useEffect, useState } from 'react';
import { useSeo } from '../lib/seo';
import { api } from '../lib/api';
import { useT } from '../i18n/useT';
import { PublicNav } from '../components/PublicNav';
import { PublicFooter } from '../components/PublicFooter';
import { IconAlert, IconCheck } from '../components/Icons';

const REFRESCO_MS = 60_000;

function useEstados() {
  const t = useT('status');
  return {
    operational: { label: t('statusOperational'), color: 'ok' },
    degraded: { label: t('statusDegraded'), color: 'warn' },
    down: { label: t('statusDown'), color: 'down' },
    unavailable: { label: t('statusUnavailable'), color: 'off' },
  };
}

function useCabecera() {
  const t = useT('status');
  return {
    operational: t('headerOperational'),
    degraded: t('headerDegraded'),
    down: t('headerDown'),
    unavailable: t('headerOperational'),
  };
}

function duracion(min, t) {
  if (min < 60) return `${min} ${t('minUnit')}`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? `${h} ${t('hourUnit')} ${m} ${t('minUnit')}` : `${h} ${t('hourUnit')}`;
  return `${Math.floor(h / 24)} ${t('dayUnit')} ${h % 24} ${t('hourUnit')}`;
}

function Uptime({ dias, total, t, ESTADOS }) {
  const fechaCorta = (iso) => new Date(iso).toLocaleDateString(t('dateLocaleShort'), { day: 'numeric', month: 'short' });
  return (
    <div className="status__uptime">
      <div className="status__barras" aria-hidden="true">
        {dias.map((d) => (
          <span key={d.date} className={`status__barra ${d.status ? `is-${ESTADOS[d.status].color}` : 'is-none'}`}
            title={d.status ? t('tooltipWithUptime', { date: fechaCorta(d.date), uptime: d.uptime }) : t('tooltipNoData', { date: fechaCorta(d.date) })} />
        ))}
      </div>
      <div className="status__leyenda">
        <span>{t('daysAgo', { n: dias.length })}</span>
        <span>{total == null ? t('noDataYet') : t('availabilityPct', { pct: total })}</span>
        <span>{t('today')}</span>
      </div>
    </div>
  );
}

function Componente({ c, t, ESTADOS }) {
  const e = ESTADOS[c.status] || ESTADOS.unavailable;
  return (
    <li className="status__item">
      <div className="status__fila">
        <div className="status__nombre">
          <h3>{c.name}</h3>
          <p>{c.description}</p>
        </div>
        <div className={`status__estado is-${e.color}`} title={c.detail || ''}>
          <span className="status__punto" />
          {e.label}
          {c.detail && <small>{c.detail}</small>}
        </div>
      </div>
      <Uptime dias={c.days} total={c.uptime} t={t} ESTADOS={ESTADOS} />
    </li>
  );
}

function Incidentes({ lista, componentes, t, ESTADOS }) {
  const fechaLarga = (iso) => {
    const f = new Date(iso).toLocaleDateString(t('dateLocaleLong'), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    return f.charAt(0).toUpperCase() + f.slice(1);
  };
  const hora = (iso) => new Date(iso).toLocaleTimeString(t('dateLocaleShort'), { hour: '2-digit', minute: '2-digit' });

  if (lista.length === 0) {
    return (
      <p className="status__vacio"><IconCheck size={15} /> {t('noIncidents')}</p>
    );
  }
  const porDia = new Map();
  lista.forEach((i) => {
    const dia = new Date(i.started_at).toDateString();
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(i);
  });
  const actual = Object.fromEntries(componentes.map((c) => [c.id, c.status]));
  return (
    <ol className="status__incidentes">
      {[...porDia].map(([dia, incs]) => (
        <li key={dia} className="status__dia">
          <h4>{fechaLarga(dia)}</h4>
          <ul>
            {incs.map((i) => {
              const e = ESTADOS[i.status];
              const enCurso = !i.ended_at && actual[i.component] === i.status;
              return (
                <li key={`${i.component}-${i.started_at}`} className="status__incidente">
                  <span className={`status__punto is-${e.color}`} />
                  <div>
                    <strong>{i.name}</strong> · {e.label.toLowerCase()} {t('during')} {duracion(i.duration_min, t)}
                    <small>
                      {hora(i.started_at)}{i.ended_at ? ` – ${hora(i.ended_at)}` : ''}
                      {enCurso && <span className="status__encurso">{t('ongoing')}</span>}
                    </small>
                  </div>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ol>
  );
}

export default function StatusPage() {
  const t = useT('status');
  const ESTADOS = useEstados();
  const CABECERA = useCabecera();
  useSeo({
    title: t('seoTitle'),
    description: t('seoDescription'),
    path: '/status',
  });
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [ahora, setAhora] = useState(() => Date.now());

  useEffect(() => {
    let vivo = true;
    const cargar = () => api.get('/api/status')
      .then((r) => { if (vivo) { setData(r.data); setError(false); } })
      .catch(() => { if (vivo) setError(true); });
    cargar();
    const t2 = setInterval(cargar, REFRESCO_MS);
    const reloj = setInterval(() => setAhora(Date.now()), 10_000);
    return () => { vivo = false; clearInterval(t2); clearInterval(reloj); };
  }, []);

  const global = data ? (ESTADOS[data.status] || ESTADOS.operational) : null;
  const haceSeg = data ? Math.max(0, Math.round((ahora - new Date(data.updated_at).getTime()) / 1000)) : 0;

  return (
    <div className="page">
      <PublicNav />
      <main className="page__body page__body--wide status">
        <h1 className="page__title page__title--center">{t('seoTitle')}</h1>
        <p className="plans__sub">{t('subtitle')}</p>

        {error && !data ? (
          <div className="status__cabecera is-down">
            <IconAlert size={20} />
            <div>
              <h2>{t('cannotCheckTitle')}</h2>
              <p>{t('cannotCheckBefore')} <a href="mailto:soporte@lixbon.com">soporte@lixbon.com</a>.</p>
            </div>
          </div>
        ) : !data ? (
          <div className="status__cabecera is-cargando">
            <span className="status__punto" />
            <div><h2>{t('checking')}</h2></div>
          </div>
        ) : (
          <div className={`status__cabecera is-${global.color}`}>
            <span className="status__punto status__punto--grande" />
            <div>
              <h2>{CABECERA[data.status]}</h2>
              <p>
                {haceSeg < 5 ? t('updatedMoment') : t('updatedSeconds', { n: haceSeg })}
                {error && ` · ${t('offlineNote')}`}
              </p>
            </div>
          </div>
        )}

        {data && (
          <>
            <ul className="status__lista">
              {data.components.map((c) => <Componente key={c.id} c={c} t={t} ESTADOS={ESTADOS} />)}
            </ul>

            <section className="status__seccion">
              <h2>{t('incidentsHeading')}</h2>
              <Incidentes lista={data.incidents} componentes={data.components} t={t} ESTADOS={ESTADOS} />
            </section>

            <p className="status__nota">
              {t('sampleNoteBefore')} {Math.round(data.sample_interval_s / 60)} {t('sampleNoteMid')}{' '}
              <a href="mailto:soporte@lixbon.com">soporte@lixbon.com</a>{t('sampleNoteAfter')}
            </p>
          </>
        )}
      </main>
      <PublicFooter />
    </div>
  );
}
