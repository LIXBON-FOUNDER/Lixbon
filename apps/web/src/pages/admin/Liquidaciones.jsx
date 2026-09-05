import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { IconDownload, IconRefresh } from '../../components/Icons';
import {
  Aviso, Boton, Cabecera, Cargando, Celda, Chip, Fila, Stat, Tabla, Vacio,
  errMsg, fmtDia, fmtUSD,
} from './comunes';

const COLS = 'minmax(0,1.2fr) 150px 150px 140px 150px';

const CABECERAS = [
  { label: 'Lote' }, { label: 'Importe', num: true }, { label: 'Llega el' },
  { label: 'Método' }, { label: 'Estado' },
];

const ESTADO = {
  paid: { tono: 'ok', texto: 'Depositado' },
  in_transit: { tono: 'warn', texto: 'En camino' },
  pending: { tono: 'warn', texto: 'Pendiente' },
  canceled: { tono: 'off', texto: 'Cancelado' },
  failed: { tono: 'bad', texto: 'Fallido' },
};

function exportarCSV(lotes) {
  const lineas = [['lote', 'importe', 'moneda', 'llega', 'metodo', 'estado'].join(',')];
  for (const l of lotes) {
    lineas.push([l.id, l.amount, l.currency, l.arrival_date || '', l.method || '', l.status].join(','));
  }
  const blob = new Blob([lineas.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lixbon-liquidaciones-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Liquidaciones() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const cargar = useCallback(() => {
    api.get('/api/admin/payments/payouts')
      .then((r) => { setData(r.data); setError(''); })
      .catch((e) => setError(errMsg(e, 'No se pudieron leer las liquidaciones')));
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const lotes = data?.payouts || [];
  const enCamino = lotes.find((l) => l.status === 'in_transit' || l.status === 'pending');

  return (
    <>
      <Cabecera
        titulo="Liquidaciones"
        lead="Lo que la pasarela deposita en la cuenta del negocio, por lote."
      >
        <Boton onClick={cargar}><IconRefresh size={15} /> Refrescar</Boton>
        <Boton disabled={!lotes.length} onClick={() => exportarCSV(lotes)}>
          <IconDownload size={15} /> Exportar
        </Boton>
      </Cabecera>

      <div className="adm__body">
        <Aviso error>{error}</Aviso>

        {data && (
          <div className="adm-stats">
            <Stat
              label="Próxima liquidación"
              valor={enCamino ? fmtUSD(enCamino.amount) : '—'}
              pie={enCamino ? `Llega el ${fmtDia(enCamino.arrival_date)}` : 'Ningún lote en camino'}
            />
            <Stat
              label="Disponible"
              valor={fmtUSD(data.balance.available)}
              pie="Listo para el siguiente depósito"
            />
            <Stat
              label="Pendiente"
              valor={fmtUSD(data.balance.pending)}
              pie="Cobros aún en el periodo de espera de la pasarela"
            />
          </div>
        )}

        <div className="adm-card adm-card--tabla">
          {!data ? <Cargando /> : lotes.length === 0 ? (
            <Vacio>
              Todavía no hay ninguna liquidación. Aparecerán aquí en cuanto la pasarela
              haga el primer depósito.
            </Vacio>
          ) : (
            <Tabla cols={COLS} cabeceras={CABECERAS} ancho={860}>
              {lotes.map((l) => {
                const e = ESTADO[l.status] || { tono: 'off', texto: l.status };
                return (
                  <Fila key={l.id} cols={COLS}>
                    <Celda><span className="mono">{l.id}</span></Celda>
                    <Celda num>{fmtUSD(l.amount)}</Celda>
                    <Celda>
                      <span className="adm-lista__label">{fmtDia(l.arrival_date)}</span>
                    </Celda>
                    <Celda>
                      <span className="adm-lista__label">
                        {l.method === 'instant' ? 'Inmediato' : 'Transferencia'}
                      </span>
                    </Celda>
                    <Celda><Chip tono={e.tono} punto>{e.texto}</Chip></Celda>
                  </Fila>
                );
              })}
            </Tabla>
          )}
          <p className="adm-card__nota">
            El importe es el <strong>neto</strong>: la pasarela ya descontó su comisión
            de cada cobro antes de agrupar el lote. El desglose por cobro está en
            Transacciones.
          </p>
        </div>
      </div>
    </>
  );
}
