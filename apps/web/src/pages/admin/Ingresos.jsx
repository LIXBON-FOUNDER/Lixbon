import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { IconDownload, IconPlus } from '../../components/Icons';
import {
  Aviso, Boton, Cabecera, Cargando, Celda, Fila, Stat, Tabla, Tarjeta, Vacio,
  errMsg, fmtNum, fmtTokens, fmtUSD,
} from './comunes';

const COLS_MODELO = 'minmax(0,1fr) 112px 104px 120px';
const COLS_USUARIO = 'minmax(0,1fr) 104px 116px';

const CAB_MODELO = [
  { label: 'Modelo' }, { label: 'Tokens', num: true },
  { label: 'Peticiones', num: true }, { label: 'Consumido', num: true },
];

const CAB_USUARIO = [
  { label: 'Usuario' }, { label: 'Tokens', num: true }, { label: 'Consumido', num: true },
];

function exportarCSV(data) {
  const filas = [['modelo', 'tokens', 'peticiones', 'consumido_usd'].join(',')];
  for (const r of data.usage_by_model) {
    filas.push([r.model, r.tokens, r.requests, r.cost_usd].join(','));
  }
  const blob = new Blob([filas.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lixbon-consumo-${data.month}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function Acreditar({ onHecho }) {
  const [email, setEmail] = useState('');
  const [monto, setMonto] = useState('');
  const [nota, setNota] = useState('');
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState('');
  const [error, setError] = useState('');

  const acreditar = async () => {
    const cifra = parseFloat(monto);
    if (!email.trim() || !Number.isFinite(cifra) || cifra === 0) {
      setError('Indica un correo y un monto distinto de 0.');
      return;
    }
    setBusy(true);
    setError('');
    setOk('');
    try {
      const r = await api.post('/api/admin/credits/grant', {
        email: email.trim(),
        amount_usd: cifra,
        note: nota.trim() || null,
      });
      setOk(`Acreditado ${fmtUSD(r.data.granted_usd)} — saldo nuevo ${fmtUSD(r.data.balance_usd, 4)}`);
      setMonto('');
      setNota('');
      onHecho();
    } catch (e) {
      setError(errMsg(e, 'No se pudo acreditar el saldo'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Tarjeta titulo="Acreditar saldo de API">
      <p className="adm-card__nota">
        Añade créditos sin pasar por Stripe (pruebas, promociones, soporte). Queda en
        el ledger como <span className="mono">grant</span>; un monto negativo corrige
        un abono erróneo.
      </p>
      <div className="adm-campos">
        <label className="adm-campo">
          <span className="adm-campo__label">Correo del usuario</span>
          <input
            className="adm-input"
            type="email"
            placeholder="persona@ejemplo.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="adm-campo">
          <span className="adm-campo__label">Monto en USD</span>
          <input
            className="adm-input adm-input--mono"
            inputMode="decimal"
            placeholder="5"
            value={monto}
            onChange={(e) => setMonto(e.target.value)}
          />
        </label>
        <label className="adm-campo">
          <span className="adm-campo__label">Nota (opcional)</span>
          <input
            className="adm-input"
            placeholder="promoción de lanzamiento"
            value={nota}
            onChange={(e) => setNota(e.target.value)}
          />
        </label>
      </div>
      <Aviso>{ok}</Aviso>
      <Aviso error>{error}</Aviso>
      <div className="adm-card__pie">
        <Boton
          variante="primary"
          disabled={busy || !email.trim() || !monto.trim()}
          onClick={acreditar}
        >
          <IconPlus size={15} /> {busy ? 'Acreditando…' : 'Acreditar'}
        </Boton>
      </div>
    </Tarjeta>
  );
}

export default function Ingresos() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const cargar = useCallback(() => {
    api.get('/api/admin/credits/summary')
      .then((r) => setData(r.data))
      .catch((e) => setError(errMsg(e, 'No se pudo cargar el resumen de ingresos')));
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const consumo = (data?.usage_by_model || []).reduce((a, r) => a + r.cost_usd, 0);

  return (
    <>
      <Cabecera
        titulo="Ingresos"
        lead="Suscripciones y recargas del mes. El consumo de créditos no es ingreso: es saldo ya pagado que se gasta."
      >
        <Boton disabled={!data} onClick={() => exportarCSV(data)}>
          <IconDownload size={15} /> Exportar
        </Boton>
      </Cabecera>

      <div className="adm__body">
        <Aviso error>{error}</Aviso>

        {!data ? <Cargando /> : (
          <>
            <div className="adm-rejilla-4">
              <Stat
                label={`Ingresos ${data.month}`}
                valor={fmtUSD(data.total_revenue_usd)}
                pie="suscripciones + recargas"
              />
              <Stat
                label="MRR"
                valor={fmtUSD(data.subscription_mrr_usd)}
                pie={`${fmtNum(data.active_subscriptions)} suscripciones de pago activas`}
              />
              <Stat
                label="Recargas de créditos"
                valor={fmtUSD(data.topups_usd)}
                pie={`${fmtNum(data.purchases)} compras este mes`}
              />
              <Stat
                label="Créditos consumidos"
                valor={fmtUSD(consumo, 4)}
                pie="saldo prepago gastado · no es ingreso"
              />
            </div>

            <Acreditar onHecho={cargar} />

            <div className="adm-rejilla-2">
              <div className="adm-card adm-card--tabla">
                <h2 className="adm-card__title">Consumo de créditos por modelo</h2>
                {data.usage_by_model.length === 0 ? (
                  <Vacio>Sin consumo de créditos este mes.</Vacio>
                ) : (
                  <Tabla cols={COLS_MODELO} cabeceras={CAB_MODELO} ancho={620}>
                    {data.usage_by_model.map((r) => (
                      <Fila key={r.model} cols={COLS_MODELO}>
                        <Celda><span className="mono">{r.model}</span></Celda>
                        <Celda num>{fmtTokens(r.tokens)}</Celda>
                        <Celda num>{fmtNum(r.requests)}</Celda>
                        <Celda num>{fmtUSD(r.cost_usd, 4)}</Celda>
                      </Fila>
                    ))}
                  </Tabla>
                )}
                <p className="adm-card__nota">
                  El costo se congela al momento del cobro: editar una tarifa después no
                  recalcula lo ya cobrado.
                </p>
              </div>

              <div className="adm-card adm-card--tabla">
                <h2 className="adm-card__title">Mayores consumidores</h2>
                {data.top_consumers.length === 0 ? (
                  <Vacio>Sin consumo de créditos este mes.</Vacio>
                ) : (
                  <Tabla cols={COLS_USUARIO} cabeceras={CAB_USUARIO} ancho={460}>
                    {data.top_consumers.map((r) => (
                      <Fila key={r.email} cols={COLS_USUARIO}>
                        <Celda>{r.email}</Celda>
                        <Celda num>{fmtTokens(r.tokens)}</Celda>
                        <Celda num>{fmtUSD(r.cost_usd, 4)}</Celda>
                      </Fila>
                    ))}
                  </Tabla>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
