import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { IconDownload, IconRefresh, IconSearch } from '../../components/Icons';
import {
  Aviso, Boton, Cabecera, Cargando, Celda, Chip, Fila, Stat, Tabla, Vacio,
  errMsg, fmtFecha, fmtNum, fmtUSD,
} from './comunes';

const COLS = '190px minmax(0,1.6fr) minmax(0,1.4fr) 118px 110px 118px 150px';

const CABECERAS = [
  { label: 'Referencia' }, { label: 'Usuario' }, { label: 'Concepto' },
  { label: 'Método' }, { label: 'Monto', num: true }, { label: 'Estado' },
  { label: 'Fecha' },
];

// Stripe tiene más estados de los que un operador necesita distinguir: lo que
// importa es si el dinero entró, si está a medias o si el banco dijo que no.
const ESTADO = {
  succeeded: { tono: 'ok', texto: 'Aprobada' },
  processing: { tono: 'warn', texto: 'Procesando' },
  requires_action: { tono: 'warn', texto: 'Esperando al banco' },
  requires_confirmation: { tono: 'warn', texto: 'Sin confirmar' },
  requires_payment_method: { tono: 'bad', texto: 'Rechazada' },
  canceled: { tono: 'off', texto: 'Cancelada' },
};

const estadoDe = (s) => ESTADO[s] || { tono: 'off', texto: s };

function exportarCSV(filas) {
  const cab = ['referencia', 'usuario', 'concepto', 'metodo', 'monto', 'moneda', 'estado', 'fecha'];
  const lineas = [cab.join(',')];
  for (const f of filas) {
    lineas.push([
      f.reference, f.email || '', `"${f.concept}"`, f.last4 ? `****${f.last4}` : '',
      f.amount, f.currency, f.status, f.date || '',
    ].join(','));
  }
  const blob = new Blob([lineas.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lixbon-transacciones-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Transacciones() {
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [estado, setEstado] = useState('');
  const [error, setError] = useState('');
  const [cargando, setCargando] = useState(false);

  const cargar = useCallback((consulta) => {
    setCargando(true);
    api.get('/api/admin/payments/transactions', { params: consulta ? { q: consulta } : {} })
      .then((r) => { setData(r.data); setError(''); })
      .catch((e) => setError(errMsg(e, 'No se pudieron leer las transacciones')))
      .finally(() => setCargando(false));
  }, []);

  useEffect(() => { cargar(''); }, [cargar]);

  const filas = (data?.transactions || [])
    .filter((f) => !estado || f.status === estado);
  const hoy = data?.today;

  return (
    <>
      <Cabecera
        titulo="Transacciones"
        lead="Cada intento de cobro que pasa por la pasarela. Lo que de eso es ingreso se resume en Ingresos."
      >
        <Boton onClick={() => cargar(q)}><IconRefresh size={15} /> Refrescar</Boton>
        <Boton disabled={!filas.length} onClick={() => exportarCSV(filas)}>
          <IconDownload size={15} /> Exportar
        </Boton>
      </Cabecera>

      <div className="adm__body">
        <Aviso error>{error}</Aviso>

        {hoy && (
          <div className="adm-stats">
            <Stat
              label="Cobrado hoy"
              valor={fmtUSD(hoy.charged)}
              pie={`${fmtNum(hoy.count)} cobros aprobados`}
            />
            <Stat
              label="Aprobación"
              valor={hoy.approval_rate != null ? `${hoy.approval_rate}%` : '—'}
              pie={`de ${fmtNum(hoy.attempts)} intentos hoy`}
            />
            <Stat
              label="Rechazos hoy"
              valor={fmtNum(hoy.declined)}
              pie={hoy.truncated
                ? 'Solo se miran los últimos 100 intentos del día'
                : 'Intentos que el banco no autorizó'}
            />
          </div>
        )}

        <form className="adm-filtros" onSubmit={(e) => { e.preventDefault(); cargar(q); }}>
          <div className="adm-buscar">
            <IconSearch size={16} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar por referencia, correo o últimos 4 dígitos…"
              aria-label="Buscar transacciones"
            />
          </div>
          <select
            className="adm-btn"
            value={estado}
            onChange={(e) => setEstado(e.target.value)}
            aria-label="Filtrar por estado"
          >
            <option value="">Estado: todos</option>
            {Object.entries(ESTADO).map(([k, v]) => (
              <option key={k} value={k}>{v.texto}</option>
            ))}
          </select>
          <Boton type="submit" variante="primary" disabled={cargando}>
            {cargando ? 'Buscando…' : 'Buscar'}
          </Boton>
        </form>

        <div className="adm-card adm-card--tabla">
          {!data ? (error ? null : <Cargando />) : filas.length === 0 ? (
            <Vacio>Ninguna transacción coincide con el filtro.</Vacio>
          ) : (
            <Tabla cols={COLS} cabeceras={CABECERAS} ancho={1100}>
              {filas.map((f) => {
                const e = estadoDe(f.status);
                return (
                  <Fila key={f.reference} cols={COLS}>
                    <Celda><span className="mono">{f.reference}</span></Celda>
                    <Celda>
                      <span className="adm-lista__label">{f.email || 'Sin usuario'}</span>
                    </Celda>
                    <Celda>
                      <span className="adm-evento">
                        <span>{f.concept}</span>
                        {f.automatic && <Chip>Automática</Chip>}
                      </span>
                    </Celda>
                    <Celda>
                      <span className="mono">{f.last4 ? `•••• ${f.last4}` : '—'}</span>
                    </Celda>
                    <Celda num>{fmtUSD(f.amount)}</Celda>
                    <Celda>
                      <Chip tono={e.tono} punto>{e.texto}</Chip>
                    </Celda>
                    <Celda>
                      <span className="adm-lista__label">{fmtFecha(f.date)}</span>
                    </Celda>
                  </Fila>
                );
              })}
            </Tabla>
          )}
          <p className="adm-card__nota">
            Los rechazos guardan el motivo que dio el emisor: pásalo tal cual si un
            usuario pregunta por qué no le pasó el cobro.
          </p>
        </div>
      </div>
    </>
  );
}
