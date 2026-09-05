import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { UsageChart } from '../../components/UsageChart';
import {
  Aviso, Boton, Cabecera, Cargando, Chip, Medida, Vacio,
  errMsg, fmtNum, fmtUSD, nombrePlan,
} from './comunes';
import { IconDownload } from '../../components/Icons';

function exportarCSV(daily) {
  const filas = [['fecha', 'peticiones', 'tokens'].join(',')];
  for (const d of daily) {
    filas.push([d.usage_date, d.requests ?? '', d.total_tokens ?? ''].join(','));
  }
  const blob = new Blob([filas.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lixbon-uso-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function CardIngresos({ creditos }) {
  if (!creditos) return <div className="adm-inicio__card"><Cargando /></div>;

  const suscripciones = creditos.subscription_mrr_usd || 0;
  const recargas = creditos.topups_usd || 0;
  const tope = Math.max(suscripciones, recargas, 0.01);
  const barras = [
    { label: 'Suscripciones', valor: suscripciones },
    { label: 'Recargas', valor: recargas },
  ];

  return (
    <div className="adm-inicio__card">
      <div className="adm-card__head">
        <h2 className="adm-card__title">Ingresos</h2>
        <Chip>{creditos.month}</Chip>
      </div>
      <div className="adm-precio">
        <span className="adm-precio__simbolo">$</span>
        <span className="adm-precio__cifra">
          {(creditos.total_revenue_usd || 0).toFixed(2).replace('.', ',')}
        </span>
      </div>
      <div className="adm-columnas">
        {barras.map((b, i) => (
          <div key={b.label} className="adm-columnas__item">
            <span className="adm-columnas__cifra">{fmtUSD(b.valor)}</span>
            <span
              className="adm-columnas__barra"
              style={{
                height: `${Math.max(4, (b.valor / tope) * 62)}px`,
                background: i === 0 ? 'var(--accent-deep)' : '#4E5A22',
              }}
            />
            <span className="adm-columnas__label">{b.label}</span>
          </div>
        ))}
      </div>
      <div className="adm-metrica">
        <span className="adm-metrica__label">Suscripciones de pago activas</span>
        <span className="adm-metrica__valor">{fmtNum(creditos.active_subscriptions)}</span>
      </div>
    </div>
  );
}

function estadoDeNodo(st) {
  if (!st) return { tono: 'off', texto: 'Sin datos' };
  if (st.online) return { tono: 'ok', texto: 'En línea' };
  if (st.circuit_breaker) return { tono: 'bad', texto: 'Aislado' };
  return { tono: 'warn', texto: 'Fuera de línea' };
}

function CardServicio({ nodos }) {
  if (!nodos) return <div className="adm-inicio__card"><Cargando /></div>;

  const vivos = nodos.filter((n) => n.online).length;
  const sano = vivos === nodos.length && nodos.length > 0;

  return (
    <div className="adm-inicio__card">
      <div className="adm-card__head">
        <h2 className="adm-card__title">Estado del servicio</h2>
        <Chip tono={sano ? 'ok' : 'warn'} punto>
          {nodos.length === 0
            ? 'Sin nodos registrados'
            : sano ? 'Sin problemas' : `${nodos.length - vivos} fuera de línea`}
        </Chip>
      </div>

      {nodos.length === 0 ? (
        <Vacio>Registra un nodo para que el clúster empiece a servir peticiones.</Vacio>
      ) : (
        <div className="adm-lista">
          {nodos.slice(0, 5).map((n) => {
            const e = estadoDeNodo(n);
            return (
              <div key={n.id} className="adm-lista__fila">
                <span className="adm-lista__label">{n.id}</span>
                <Chip tono={e.tono} punto>{e.texto}</Chip>
              </div>
            );
          })}
        </div>
      )}

      <div className="adm-leyenda">
        <span className="adm-leyenda__item">
          <span className="adm-leyenda__muestra" style={{ background: 'var(--ok)' }} />Operativo
        </span>
        <span className="adm-leyenda__item">
          <span className="adm-leyenda__muestra" style={{ background: 'var(--warn)' }} />Degradado
        </span>
        <span className="adm-leyenda__item">
          <span className="adm-leyenda__muestra" style={{ background: 'var(--danger)' }} />Caída
        </span>
      </div>
    </div>
  );
}

function CardPlanes({ totals }) {
  if (!totals) return <div className="adm-inicio__card"><Cargando /></div>;

  const porPlan = totals.by_plan || {};
  const entradas = Object.entries(porPlan);
  const total = entradas.reduce((a, [, n]) => a + n, 0) || 1;
  const dePago = entradas
    .filter(([id]) => id !== 'free')
    .reduce((a, [, n]) => a + n, 0);

  return (
    <div className="adm-inicio__card">
      <h2 className="adm-card__title">Usuarios por plan</h2>
      {entradas.length === 0 ? (
        <Vacio>Sin suscripciones todavía.</Vacio>
      ) : (
        <div className="adm-lista">
          {entradas.map(([id, n]) => (
            <Medida
              key={id}
              gruesa
              label={nombrePlan(id)}
              valor={fmtNum(n)}
              pct={(n / total) * 100}
            />
          ))}
        </div>
      )}
      <div className="adm-metrica">
        <span className="adm-metrica__label">Conversión a plan de pago</span>
        <span className="adm-metrica__valor">
          {((dePago / total) * 100).toFixed(1).replace('.', ',')}%
        </span>
      </div>
    </div>
  );
}

export default function Inicio() {
  const [metrics, setMetrics] = useState(null);
  const [nodos, setNodos] = useState(null);
  const [creditos, setCreditos] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/admin/metrics')
      .then((r) => setMetrics(r.data))
      .catch((e) => setError(errMsg(e, 'No se pudieron cargar las métricas')));
    api.get('/api/admin/nodes')
      .then((r) => setNodos(r.data.live_status))
      .catch(() => setNodos([]));
    api.get('/api/admin/credits/summary')
      .then((r) => setCreditos(r.data))
      .catch(() => {});
  }, []);

  const totals = metrics?.totals;

  return (
    <>
      <Cabecera titulo="Inicio" lead="Estado del clúster y del negocio, hoy.">
        <Boton
          variante="primary"
          disabled={!metrics}
          onClick={() => exportarCSV(metrics.daily || [])}
        >
          <IconDownload size={15} /> Exportar
        </Boton>
      </Cabecera>

      <div className="adm__body">
        <Aviso error>{error}</Aviso>

        <div className="adm-inicio">
          <CardIngresos creditos={creditos} />
          <CardServicio nodos={nodos} />
          <CardPlanes totals={totals} />
        </div>

        {totals && (
          <div className="adm-stats">
            <StatMini label="Usuarios" valor={fmtNum(totals.users)} />
            <StatMini label="Activos (30 días)" valor={fmtNum(totals.active_users_period)} />
            <StatMini label="Bloqueados" valor={fmtNum(totals.users_blocked)} />
            <StatMini label="Conversaciones" valor={fmtNum(totals.conversations)} />
            <StatMini label="Mensajes" valor={fmtNum(totals.messages)} />
            <StatMini
              label="Nodos en línea"
              valor={`${metrics.nodes.online} / ${metrics.nodes.total}`}
            />
          </div>
        )}

        <div className="adm-tokens">
          <h2 className="adm-card__title">Tokens · todo el sistema, 30 días</h2>
          {metrics ? <UsageChart daily={metrics.daily} /> : <Cargando />}
        </div>
      </div>
    </>
  );
}

function StatMini({ label, valor }) {
  return (
    <div className="adm-stat">
      <span className="adm-stat__label">{label}</span>
      <span className="adm-stat__valor">{valor}</span>
    </div>
  );
}
