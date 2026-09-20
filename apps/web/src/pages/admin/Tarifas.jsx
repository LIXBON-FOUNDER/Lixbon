import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useConfirmar } from '../../hooks/useConfirmar';
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

const CABECERAS_PESOS = [
  { label: 'Prefijo' }, { label: 'Nombre' },
  { label: 'créditos entrada / Mtok' }, { label: 'créditos salida / Mtok' },
  { label: 'Estado' }, { label: '', key: 'acciones' },
];

const NUEVO_PESO = { model_prefix: '', display_name: '', input: '', output: '' };

export default function Tarifas() {
  const confirmar = useConfirmar();
  const [filas, setFilas] = useState(null);
  const [borrador, setBorrador] = useState({});
  const [nueva, setNueva] = useState(NUEVA);
  const [planes, setPlanes] = useState([]);
  const [precios, setPrecios] = useState({});
  const [multiplicadores, setMultiplicadores] = useState({});
  const [politica, setPolitica] = useState(null);
  const [pesos, setPesos] = useState(null);
  const [borradorPesos, setBorradorPesos] = useState({});
  const [nuevoPeso, setNuevoPeso] = useState(NUEVO_PESO);
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

  const cargarPesos = useCallback(async () => {
    try {
      const r = await api.get('/api/admin/model-weights');
      setPesos(r.data.model_weights);
      setBorradorPesos(Object.fromEntries(r.data.model_weights.map((x) => [x.id, {
        input: String(x.input_credits_per_mtok),
        output: String(x.output_credits_per_mtok),
      }])));
    } catch (e) {
      setError(errMsg(e, 'No se pudieron cargar los pesos por modelo'));
    }
  }, []);

  useEffect(() => {
    cargar();
    cargarPesos();
    api.get('/api/admin/models')
      .then((r) => {
        setPlanes(r.data.plans);
        setPrecios(Object.fromEntries(
          r.data.plans.map((p) => [p.id, p.stripe_price_id || '']),
        ));
        setMultiplicadores(Object.fromEntries(r.data.plans.map((p) => [p.id, {
          session: String(p.session_credit_multiplier),
          week: String(p.week_credit_multiplier),
        }])));
      })
      .catch(() => {});
    api.get('/api/admin/usage-policy')
      .then((r) => {
        const p = r.data.usage_policy;
        setPolitica({
          session_window_hours: String(p.session_window_hours),
          session_base_credits: String(p.session_base_credits),
          week_base_credits: String(p.week_base_credits),
        });
      })
      .catch((e) => setError(errMsg(e, 'No se pudo cargar la política de créditos')));
  }, [cargar, cargarPesos]);

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
    const ok = await confirmar({
      titulo: `¿Eliminar la tarifa de "${fila.model_prefix}"?`,
      texto: 'Los modelos que la usaban pasarán a la tarifa por defecto (*).',
      etiqueta: 'Eliminar tarifa',
    });
    if (!ok) return;
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

  const guardarMultiplicadores = async (planId) => {
    setError('');
    const d = multiplicadores[planId];
    try {
      await api.patch(`/api/admin/plans/${planId}`, {
        session_credit_multiplier: parseFloat(d.session) || 0,
        week_credit_multiplier: parseFloat(d.week) || 0,
      });
      setGuardado(`mult-${planId}`);
      setTimeout(() => setGuardado(null), 2500);
    } catch (e) {
      setError(errMsg(e, 'No se pudo guardar el multiplicador'));
    }
  };

  const guardarPolitica = async () => {
    setError('');
    try {
      await api.patch('/api/admin/usage-policy', {
        session_window_hours: parseFloat(politica.session_window_hours) || 0,
        session_base_credits: parseInt(politica.session_base_credits, 10) || 0,
        week_base_credits: parseInt(politica.week_base_credits, 10) || 0,
      });
      setGuardado('politica');
      setTimeout(() => setGuardado(null), 2500);
    } catch (e) {
      setError(errMsg(e, 'No se pudo guardar la política de créditos'));
    }
  };

  const guardarPeso = async (fila) => {
    setError('');
    const d = borradorPesos[fila.id];
    try {
      await api.patch(`/api/admin/model-weights/${fila.id}`, {
        input_credits_per_mtok: parseInt(d.input, 10) || 0,
        output_credits_per_mtok: parseInt(d.output, 10) || 0,
      });
      setGuardado(`peso-${fila.id}`);
      setTimeout(() => setGuardado(null), 2500);
      cargarPesos();
    } catch (e) {
      setError(errMsg(e, 'No se pudo guardar el peso'));
    }
  };

  const alternarPeso = async (fila) => {
    setError('');
    try {
      await api.patch(`/api/admin/model-weights/${fila.id}`, { is_active: !fila.is_active });
      cargarPesos();
    } catch (e) {
      setError(errMsg(e, 'No se pudo cambiar el estado'));
    }
  };

  const eliminarPeso = async (fila) => {
    const ok = await confirmar({
      titulo: `¿Eliminar el peso de "${fila.model_prefix}"?`,
      texto: 'Los modelos que lo usaban pasarán al peso por defecto (*).',
      etiqueta: 'Eliminar peso',
    });
    if (!ok) return;
    setError('');
    try {
      await api.delete(`/api/admin/model-weights/${fila.id}`);
      cargarPesos();
    } catch (e) {
      setError(errMsg(e, 'No se pudo eliminar'));
    }
  };

  const crearPeso = async () => {
    setError('');
    setBusy(true);
    try {
      await api.post('/api/admin/model-weights', {
        model_prefix: nuevoPeso.model_prefix.trim(),
        display_name: nuevoPeso.display_name.trim() || null,
        input_credits_per_mtok: parseInt(nuevoPeso.input, 10) || 0,
        output_credits_per_mtok: parseInt(nuevoPeso.output, 10) || 0,
      });
      setNuevoPeso(NUEVO_PESO);
      cargarPesos();
    } catch (e) {
      setError(errMsg(e, 'No se pudo crear el peso'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Cabecera
        titulo="Tarifas"
        lead="Cupo de sesión/semana del chat (créditos internos) y precio del crédito de API en USD por millón de tokens. Gana el prefijo más largo que encaje."
      />

      <div className="adm__body">
        <Aviso error>{error}</Aviso>

        <Tarjeta titulo="Política de sesión (4h) + semana">
          {!politica ? <Cargando /> : (
            <>
              <div className="adm-campos">
                <label className="adm-campo">
                  <span className="adm-campo__label">Duración de la sesión (horas)</span>
                  <input
                    className="adm-input adm-input--mono"
                    inputMode="decimal"
                    value={politica.session_window_hours}
                    onChange={(e) => setPolitica({ ...politica, session_window_hours: e.target.value })}
                  />
                </label>
                <label className="adm-campo">
                  <span className="adm-campo__label">Créditos base por sesión</span>
                  <input
                    className="adm-input adm-input--mono"
                    inputMode="numeric"
                    value={politica.session_base_credits}
                    onChange={(e) => setPolitica({ ...politica, session_base_credits: e.target.value })}
                  />
                </label>
                <label className="adm-campo">
                  <span className="adm-campo__label">Créditos base por semana</span>
                  <input
                    className="adm-input adm-input--mono"
                    inputMode="numeric"
                    value={politica.week_base_credits}
                    onChange={(e) => setPolitica({ ...politica, week_base_credits: e.target.value })}
                  />
                </label>
              </div>
              <div className="adm-card__pie">
                <Boton variante="primary" onClick={guardarPolitica}>
                  <IconCheck size={15} />
                  {guardado === 'politica' ? 'Guardado' : 'Guardar'}
                </Boton>
              </div>
              <p className="adm-card__nota">
                Cada plan multiplica esta base por su propio multiplicador de sesión/semana
                (más abajo). Un valor negativo en la base desactiva ese bucket para todos los
                planes sin tocar los multiplicadores.
              </p>
            </>
          )}
        </Tarjeta>

        <Tarjeta titulo="Multiplicadores por plan">
          {planes.length === 0 ? <Cargando /> : planes.map((p) => (
            <div key={p.id} className="adm-plan-fila">
              <span className="adm-lista__label">{p.name}</span>
              <div className="adm-fila-campo">
                <label className="adm-campo" style={{ maxWidth: 140 }}>
                  <span className="adm-campo__label">× sesión</span>
                  <input
                    className="adm-input adm-input--mono"
                    inputMode="decimal"
                    aria-label={`Multiplicador de sesión de ${p.name}`}
                    value={multiplicadores[p.id]?.session ?? ''}
                    onChange={(e) => setMultiplicadores({
                      ...multiplicadores, [p.id]: { ...multiplicadores[p.id], session: e.target.value },
                    })}
                  />
                </label>
                <label className="adm-campo" style={{ maxWidth: 140 }}>
                  <span className="adm-campo__label">× semana</span>
                  <input
                    className="adm-input adm-input--mono"
                    inputMode="decimal"
                    aria-label={`Multiplicador semanal de ${p.name}`}
                    value={multiplicadores[p.id]?.week ?? ''}
                    onChange={(e) => setMultiplicadores({
                      ...multiplicadores, [p.id]: { ...multiplicadores[p.id], week: e.target.value },
                    })}
                  />
                </label>
                <Boton variante="primary" onClick={() => guardarMultiplicadores(p.id)}>
                  <IconCheck size={15} />
                  {guardado === `mult-${p.id}` ? 'Guardado' : 'Guardar'}
                </Boton>
              </div>
            </div>
          ))}
        </Tarjeta>

        <div className="adm-card adm-card--tabla">
          {pesos === null ? <Cargando /> : pesos.length === 0 ? (
            <Vacio>No hay ningún peso cargado.</Vacio>
          ) : (
            <Tabla cols={COLS} cabeceras={CABECERAS_PESOS} ancho={900}>
              {pesos.map((f) => (
                <Fila key={f.id} cols={COLS}>
                  <Celda><span className="mono">{f.model_prefix}</span></Celda>
                  <Celda>
                    <span className="adm-lista__label">{f.display_name || '—'}</span>
                  </Celda>
                  <Celda>
                    <input
                      className="adm-input adm-input--mono adm-input--sm"
                      inputMode="numeric"
                      aria-label={`Créditos de entrada de ${f.model_prefix}`}
                      value={borradorPesos[f.id]?.input ?? ''}
                      onChange={(e) => setBorradorPesos({
                        ...borradorPesos, [f.id]: { ...borradorPesos[f.id], input: e.target.value },
                      })}
                    />
                  </Celda>
                  <Celda>
                    <input
                      className="adm-input adm-input--mono adm-input--sm"
                      inputMode="numeric"
                      aria-label={`Créditos de salida de ${f.model_prefix}`}
                      value={borradorPesos[f.id]?.output ?? ''}
                      onChange={(e) => setBorradorPesos({
                        ...borradorPesos, [f.id]: { ...borradorPesos[f.id], output: e.target.value },
                      })}
                    />
                  </Celda>
                  <Celda>
                    <button type="button" className="adm-chip-btn" onClick={() => alternarPeso(f)}>
                      <Chip tono={f.is_active ? 'ok' : 'off'} punto>
                        {f.is_active ? 'Activo' : 'Pausado'}
                      </Chip>
                    </button>
                  </Celda>
                  <Celda acciones>
                    <Boton sm variante="primary" onClick={() => guardarPeso(f)}>
                      {guardado === `peso-${f.id}` ? 'Guardado' : 'Guardar'}
                    </Boton>
                    {f.model_prefix !== '*' && (
                      <Boton sm peligro aria-label={`Eliminar ${f.model_prefix}`} onClick={() => eliminarPeso(f)}>
                        <IconTrash size={13} />
                      </Boton>
                    )}
                  </Celda>
                </Fila>
              ))}
            </Tabla>
          )}
          <p className="adm-card__nota">
            Créditos por millón de tokens que este modelo consume del pool de sesión/semana
            (F8) — no confundir con la tarifa en USD de abajo, que es el cobro de créditos
            prepago para tráfico de API externo. La fila <span className="mono">*</span> es el
            peso por defecto y no se puede eliminar.
          </p>
        </div>

        <Tarjeta titulo="Nuevo peso por modelo">
          <div className="adm-campos">
            <label className="adm-campo">
              <span className="adm-campo__label">Prefijo del modelo</span>
              <input
                className="adm-input adm-input--mono"
                placeholder="qwen2.5"
                value={nuevoPeso.model_prefix}
                onChange={(e) => setNuevoPeso({ ...nuevoPeso, model_prefix: e.target.value })}
              />
            </label>
            <label className="adm-campo">
              <span className="adm-campo__label">Nombre visible (opcional)</span>
              <input
                className="adm-input"
                placeholder="Qwen 2.5"
                value={nuevoPeso.display_name}
                onChange={(e) => setNuevoPeso({ ...nuevoPeso, display_name: e.target.value })}
              />
            </label>
            <label className="adm-campo">
              <span className="adm-campo__label">Créditos entrada / Mtok</span>
              <input
                className="adm-input adm-input--mono"
                inputMode="numeric"
                placeholder="1000000"
                value={nuevoPeso.input}
                onChange={(e) => setNuevoPeso({ ...nuevoPeso, input: e.target.value })}
              />
            </label>
            <label className="adm-campo">
              <span className="adm-campo__label">Créditos salida / Mtok</span>
              <input
                className="adm-input adm-input--mono"
                inputMode="numeric"
                placeholder="4000000"
                value={nuevoPeso.output}
                onChange={(e) => setNuevoPeso({ ...nuevoPeso, output: e.target.value })}
              />
            </label>
          </div>
          <div className="adm-card__pie">
            <Boton
              variante="primary"
              disabled={busy || !nuevoPeso.model_prefix.trim()}
              onClick={crearPeso}
            >
              <IconPlus size={15} /> Añadir peso
            </Boton>
          </div>
        </Tarjeta>

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
