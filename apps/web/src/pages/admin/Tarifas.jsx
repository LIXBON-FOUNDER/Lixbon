import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { IconCheck, IconPlus, IconTrash } from '../../components/Icons';
import {
  Aviso, Boton, Cabecera, Cargando, Celda, Chip, Fila, Tabla, Tarjeta, Vacio,
  errMsg,
} from './comunes';

const COLS = 'minmax(0,1.4fr) minmax(0,1fr) 132px 132px 110px 168px';

const CABECERAS = [
  { label: 'Prefijo' }, { label: 'Nombre' },
  { label: '$ entrada / Mtok' }, { label: '$ salida / Mtok' },
  { label: 'Estado' }, { label: '', key: 'acciones' },
];

const NUEVA = { model_prefix: '', display_name: '', input: '', output: '' };

export default function Tarifas() {
  const [filas, setFilas] = useState(null);
  const [borrador, setBorrador] = useState({});
  const [nueva, setNueva] = useState(NUEVA);
  const [planes, setPlanes] = useState([]);
  const [precios, setPrecios] = useState({});
  const [guardado, setGuardado] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const cargar = useCallback(async () => {
    try {
      const r = await api.get('/api/admin/pricing');
      setFilas(r.data.pricing);
      setBorrador(Object.fromEntries(r.data.pricing.map((x) => [x.id, {
        input: String(x.input_usd_per_mtok),
        output: String(x.output_usd_per_mtok),
      }])));
    } catch (e) {
      setError(errMsg(e, 'No se pudieron cargar las tarifas'));
    }
  }, []);

  useEffect(() => {
    cargar();
    api.get('/api/admin/models')
      .then((r) => {
        setPlanes(r.data.plans);
        setPrecios(Object.fromEntries(
          r.data.plans.map((p) => [p.id, p.stripe_price_id || '']),
        ));
      })
      .catch(() => {});
  }, [cargar]);

  const guardar = async (fila) => {
    setError('');
    const d = borrador[fila.id];
    try {
      await api.patch(`/api/admin/pricing/${fila.id}`, {
        input_usd_per_mtok: parseFloat(d.input) || 0,
        output_usd_per_mtok: parseFloat(d.output) || 0,
      });
      setGuardado(fila.id);
      setTimeout(() => setGuardado(null), 2500);
      cargar();
    } catch (e) {
      setError(errMsg(e, 'No se pudo guardar la tarifa'));
    }
  };

  const alternar = async (fila) => {
    setError('');
    try {
      await api.patch(`/api/admin/pricing/${fila.id}`, { is_active: !fila.is_active });
      cargar();
    } catch (e) {
      setError(errMsg(e, 'No se pudo cambiar el estado'));
    }
  };

  const eliminar = async (fila) => {
    const aviso = `¿Eliminar la tarifa de "${fila.model_prefix}"? `
      + 'Los modelos que la usaban pasarán a la tarifa por defecto (*).';
    if (!window.confirm(aviso)) return;
    setError('');
    try {
      await api.delete(`/api/admin/pricing/${fila.id}`);
      cargar();
    } catch (e) {
      setError(errMsg(e, 'No se pudo eliminar'));
    }
  };

  const crear = async () => {
    setError('');
    setBusy(true);
    try {
      await api.post('/api/admin/pricing', {
        model_prefix: nueva.model_prefix.trim(),
        display_name: nueva.display_name.trim() || null,
        input_usd_per_mtok: parseFloat(nueva.input) || 0,
        output_usd_per_mtok: parseFloat(nueva.output) || 0,
      });
      setNueva(NUEVA);
      cargar();
    } catch (e) {
      setError(errMsg(e, 'No se pudo crear la tarifa'));
    } finally {
      setBusy(false);
    }
  };

  const guardarPrecio = async (planId) => {
    setError('');
    try {
      await api.patch(`/api/admin/plans/${planId}`, {
        stripe_price_id: precios[planId].trim() || null,
      });
      setGuardado(`precio-${planId}`);
      setTimeout(() => setGuardado(null), 2500);
    } catch (e) {
      setError(errMsg(e, 'No se pudo guardar el precio'));
    }
  };

  return (
    <>
      <Cabecera
        titulo="Tarifas"
        lead="Precio del crédito de API en USD por millón de tokens. Gana el prefijo más largo que encaje."
      />

      <div className="adm__body">
        <Aviso error>{error}</Aviso>

        <div className="adm-card adm-card--tabla">
          {!filas ? <Cargando /> : filas.length === 0 ? (
            <Vacio>No hay ninguna tarifa cargada.</Vacio>
          ) : (
            <Tabla cols={COLS} cabeceras={CABECERAS} ancho={900}>
              {filas.map((f) => (
                <Fila key={f.id} cols={COLS}>
                  <Celda><span className="mono">{f.model_prefix}</span></Celda>
                  <Celda>
                    <span className="adm-lista__label">{f.display_name || '—'}</span>
                  </Celda>
                  <Celda>
                    <input
                      className="adm-input adm-input--mono adm-input--sm"
                      inputMode="decimal"
                      aria-label={`Entrada de ${f.model_prefix}`}
                      value={borrador[f.id]?.input ?? ''}
                      onChange={(e) => setBorrador({
                        ...borrador, [f.id]: { ...borrador[f.id], input: e.target.value },
                      })}
                    />
                  </Celda>
                  <Celda>
                    <input
                      className="adm-input adm-input--mono adm-input--sm"
                      inputMode="decimal"
                      aria-label={`Salida de ${f.model_prefix}`}
                      value={borrador[f.id]?.output ?? ''}
                      onChange={(e) => setBorrador({
                        ...borrador, [f.id]: { ...borrador[f.id], output: e.target.value },
                      })}
                    />
                  </Celda>
                  <Celda>
                    <button type="button" className="adm-chip-btn" onClick={() => alternar(f)}>
                      <Chip tono={f.is_active ? 'ok' : 'off'} punto>
                        {f.is_active ? 'Activa' : 'Pausada'}
                      </Chip>
                    </button>
                  </Celda>
                  <Celda acciones>
                    <Boton sm variante="primary" onClick={() => guardar(f)}>
                      {guardado === f.id ? 'Guardado' : 'Guardar'}
                    </Boton>
                    {f.model_prefix !== '*' && (
                      <Boton sm peligro aria-label={`Eliminar ${f.model_prefix}`} onClick={() => eliminar(f)}>
                        <IconTrash size={13} />
                      </Boton>
                    )}
                  </Celda>
                </Fila>
              ))}
            </Tabla>
          )}
          <p className="adm-card__nota">
            La fila <span className="mono">*</span> es la tarifa por defecto y no se puede
            eliminar. El costo se congela al cobrar: editar una tarifa no recalcula lo ya
            facturado, solo afecta a las peticiones nuevas.
          </p>
        </div>

        <Tarjeta titulo="Nueva tarifa">
          <div className="adm-campos">
            <label className="adm-campo">
              <span className="adm-campo__label">Prefijo del modelo</span>
              <input
                className="adm-input adm-input--mono"
                placeholder="qwen2.5"
                value={nueva.model_prefix}
                onChange={(e) => setNueva({ ...nueva, model_prefix: e.target.value })}
              />
            </label>
            <label className="adm-campo">
              <span className="adm-campo__label">Nombre visible (opcional)</span>
              <input
                className="adm-input"
                placeholder="Qwen 2.5"
                value={nueva.display_name}
                onChange={(e) => setNueva({ ...nueva, display_name: e.target.value })}
              />
            </label>
            <label className="adm-campo">
              <span className="adm-campo__label">$ entrada / Mtok</span>
              <input
                className="adm-input adm-input--mono"
                inputMode="decimal"
                placeholder="0.45"
                value={nueva.input}
                onChange={(e) => setNueva({ ...nueva, input: e.target.value })}
              />
            </label>
            <label className="adm-campo">
              <span className="adm-campo__label">$ salida / Mtok</span>
              <input
                className="adm-input adm-input--mono"
                inputMode="decimal"
                placeholder="1.20"
                value={nueva.output}
                onChange={(e) => setNueva({ ...nueva, output: e.target.value })}
              />
            </label>
          </div>
          <div className="adm-card__pie">
            <Boton
              variante="primary"
              disabled={busy || !nueva.model_prefix.trim()}
              onClick={crear}
            >
              <IconPlus size={15} /> Añadir tarifa
            </Boton>
          </div>
        </Tarjeta>

        <Tarjeta titulo="Precios de Stripe">
          <p className="adm-card__nota">
            El <span className="mono">price_…</span> de cada plan de pago, creado en
            Stripe → Productos. Es lo que conecta el plan con el checkout; el plan
            gratuito se deja vacío.
          </p>
          {planes.filter((p) => p.price_monthly_cents > 0).map((p) => (
            <div key={p.id} className="adm-plan-fila">
              <span className="adm-lista__label">{p.name}</span>
              <div className="adm-fila-campo">
                <input
                  className="adm-input adm-input--mono"
                  placeholder="price_…"
                  aria-label={`Price id de ${p.name}`}
                  value={precios[p.id] ?? ''}
                  onChange={(e) => setPrecios({ ...precios, [p.id]: e.target.value })}
                />
                <Boton variante="primary" onClick={() => guardarPrecio(p.id)}>
                  <IconCheck size={15} />
                  {guardado === `precio-${p.id}` ? 'Guardado' : 'Guardar'}
                </Boton>
              </div>
            </div>
          ))}
          {planes.length === 0 && <Vacio>Cargando los planes…</Vacio>}
        </Tarjeta>
      </div>
    </>
  );
}
