// StatusPage.jsx — estado público de los servicios (/status): estado vivo de
// cada componente, disponibilidad de 90 días e incidentes. Se refresca solo.
import { useEffect, useState } from 'react';
import { useSeo } from '../lib/seo';
import { api } from '../lib/api';
import { PublicNav } from '../components/PublicNav';
import { PublicFooter } from '../components/PublicFooter';
import { IconAlert, IconCheck } from '../components/Icons';

const REFRESCO_MS = 60_000;

const ESTADOS = {
  operational: { label: 'Operativo', color: 'ok' },
  degraded: { label: 'Degradado', color: 'warn' },
  down: { label: 'Caído', color: 'down' },
  unavailable: { label: 'No disponible', color: 'off' },
};

const CABECERA = {
  operational: 'Todos los sistemas operativos',
  degraded: 'Rendimiento degradado en parte del servicio',
  down: 'Interrupción en curso',
  unavailable: 'Todos los sistemas operativos',
};

const fechaCorta = (iso) => new Date(iso).toLocaleDateString('es', { day: 'numeric', month: 'short' });
const fechaLarga = (iso) => {
  const f = new Date(iso).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return f.charAt(0).toUpperCase() + f.slice(1);
};
const hora = (iso) => new Date(iso).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });

function duracion(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? `${h} h ${m} min` : `${h} h`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

function Uptime({ dias, total }) {
  return (
    <div className="status__uptime">
      <div className="status__barras" aria-hidden="true">
        {dias.map((d) => (
          <span key={d.date} className={`status__barra ${d.status ? `is-${ESTADOS[d.status].color}` : 'is-none'}`}
            title={d.status ? `${fechaCorta(d.date)}: ${d.uptime}%` : `${fechaCorta(d.date)}: sin datos`} />
        ))}
      </div>
      <div className="status__leyenda">
        <span>Hace {dias.length} días</span>
        <span>{total == null ? 'Sin datos todavía' : `${total}% de disponibilidad`}</span>
        <span>Hoy</span>
      </div>
    </div>
  );
}

function Componente({ c }) {
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
      <Uptime dias={c.days} total={c.uptime} />
    </li>
  );
}

function Incidentes({ lista, componentes }) {
  if (lista.length === 0) {
    return (
      <p className="status__vacio"><IconCheck size={15} /> Sin incidentes en los últimos 90 días.</p>
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
                    <strong>{i.name}</strong> · {e.label.toLowerCase()} durante {duracion(i.duration_min)}
                    <small>
                      {hora(i.started_at)}{i.ended_at ? ` – ${hora(i.ended_at)}` : ''}
                      {enCurso && <span className="status__encurso">En curso</span>}
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
  useSeo({
    title: 'Estado del servicio',
    description: 'Estado en tiempo real de lixbon: API, modelos, base de datos, pagos y correo, con la disponibilidad de los últimos 90 días.',
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
    const t = setInterval(cargar, REFRESCO_MS);
    const reloj = setInterval(() => setAhora(Date.now()), 10_000);
    return () => { vivo = false; clearInterval(t); clearInterval(reloj); };
  }, []);

  const global = data ? (ESTADOS[data.status] || ESTADOS.operational) : null;
  const haceSeg = data ? Math.max(0, Math.round((ahora - new Date(data.updated_at).getTime()) / 1000)) : 0;

  return (
    <div className="page">
      <PublicNav />
      <main className="page__body page__body--wide status">
        <h1 className="page__title page__title--center">Estado del servicio</h1>
        <p className="plans__sub">Lo que está funcionando ahora mismo y lo que ha pasado en los últimos 90 días.</p>

        {error && !data ? (
          <div className="status__cabecera is-down">
            <IconAlert size={20} />
            <div>
              <h2>No se puede consultar el estado</h2>
              <p>El gateway no responde. Si el problema sigue, escríbenos a <a href="mailto:soporte@lixbon.com">soporte@lixbon.com</a>.</p>
            </div>
          </div>
        ) : !data ? (
          <div className="status__cabecera is-cargando">
            <span className="status__punto" />
            <div><h2>Consultando…</h2></div>
          </div>
        ) : (
          <div className={`status__cabecera is-${global.color}`}>
            <span className="status__punto status__punto--grande" />
            <div>
              <h2>{CABECERA[data.status]}</h2>
              <p>
                Actualizado hace {haceSeg < 5 ? 'un momento' : `${haceSeg} s`}
                {error && ' · sin conexión con el gateway, mostrando el último estado'}
              </p>
            </div>
          </div>
        )}

        {data && (
          <>
            <ul className="status__lista">
              {data.components.map((c) => <Componente key={c.id} c={c} />)}
            </ul>

            <section className="status__seccion">
              <h2>Incidentes</h2>
              <Incidentes lista={data.incidents} componentes={data.components} />
            </section>

            <p className="status__nota">
              El gateway toma una muestra de cada servicio cada {Math.round(data.sample_interval_s / 60)} minutos;
              una interrupción más corta puede no aparecer aquí. Si algo te falla y esta página lo da por operativo,
              escríbenos a <a href="mailto:soporte@lixbon.com">soporte@lixbon.com</a>.
            </p>
          </>
        )}
      </main>
      <PublicFooter />
    </div>
  );
}
