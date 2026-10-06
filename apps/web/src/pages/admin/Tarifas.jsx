import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useConfirmar } from '../../hooks/useConfirmar';
import { IconCheck, IconPlus, IconTrash, IconX } from '../../components/Icons';
import {
  Aviso, Boton, Cabecera, Cargando, Celda, Chip, Fila, Tabla, Tarjeta, Vacio,
  errMsg, fmtNum,
} from './comunes';

// Cuatro cosas distintas que antes iban en una sola columna: se reparten en
// pestañas y cada una trae su tabla y su alta plegada.
const SECCIONES = [
  { id: 'cupo', label: 'Cupo del chat' },
  { id: 'pesos', label: 'Pesos por modelo' },
  { id: 'api', label: 'Precios de API' },
  { id: 'stripe', label: 'Stripe' },
];

const COLS = 'minmax(0,1.3fr) minmax(0,1fr) 140px 140px 104px 132px';
const COLS_PLAN = 'minmax(0,1fr) 110px 110px minmax(0,1fr) minmax(0,1fr) 120px';
const COLS_STRIPE = 'minmax(0,160px) minmax(0,1fr) 120px';

const NUEVA = { model_prefix: '', display_name: '', input: '', output: '' };
const NUEVO_PESO = { model_prefix: '', display_name: '', input: '', output: '' };

export default function Tarifas() {
  const confirmar = useConfirmar();
  const [params, setParams] = useSearchParams();
  const seccion = SECCIONES.some((x) => x.id === params.get('s')) ? params.get('s') : 'cupo';
  const [altaAbierta, setAltaAbierta] = useState(false);
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
      setAltaAbierta(false);
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
      setAltaAbierta(false);
      cargarPesos();
    } catch (e) {
      setError(errMsg(e, 'No se pudo crear el peso'));
    } finally {
      setBusy(false);
    }
  };

  const irA = (id) => {
    setAltaAbierta(false);
    setParams(id === 'cupo' ? {} : { s: id }, { replace: true });
  };

  const baseSesion = Number(politica?.session_base_credits);
  const baseSemana = Number(politica?.week_base_credits);
  const cupo = (base, mult) => {
    if (!Number.isFinite(base) || base < 0) return 'Sin límite';
    const n = Math.round(base * (parseFloat(mult) || 0));
    return fmtNum(n);
  };

  return (
    <>
      <Cabecera
        titulo="Tarifas"
        lead="Lo que consume el chat de cada plan y lo que se cobra por la API. Gana el prefijo de modelo más largo que encaje."
      />

      <div className="adm__body">
        <div className="adm-pestanas" role="tablist" aria-label="Secciones de tarifas">
          {SECCIONES.map((x) => (
            <button
              key={x.id}
              type="button"
              role="tab"
              aria-selected={seccion === x.id}
              className={seccion === x.id ? 'adm-pestana is-on' : 'adm-pestana'}
              onClick={() => irA(x.id)}
            >
              {x.label}
            </button>
          ))}
        </div>

        <Aviso error>{error}</Aviso>

        {seccion === 'cupo' && (
          <>
            <Tarjeta titulo="Base para todos los planes">
              {!politica ? <Cargando /> : (
                <>
                  <div className="adm-tarifa-base">
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
                      <span className="adm-campo__label">Créditos por sesión</span>
                      <input
                        className="adm-input adm-input--mono"
                        inputMode="numeric"
                        value={politica.session_base_credits}
                        onChange={(e) => setPolitica({ ...politica, session_base_credits: e.target.value })}
                      />
                    </label>
                    <label className="adm-campo">
                      <span className="adm-campo__label">Créditos por semana</span>
                      <input
                        className="adm-input adm-input--mono"
                        inputMode="numeric"
                        value={politica.week_base_credits}
                        onChange={(e) => setPolitica({ ...politica, week_base_credits: e.target.value })}
                      />
                    </label>
                    <Boton variante="primary" onClick={guardarPolitica}>
                      <IconCheck size={15} />
                      {guardado === 'politica' ? 'Guardado' : 'Guardar'}
                    </Boton>
                  </div>
                  <p className="adm-card__nota">
                    Un valor negativo desactiva ese límite para todos los planes.
                  </p>
                </>
              )}
            </Tarjeta>

            <Tarjeta titulo="Por plan" tabla>
              {planes.length === 0 ? <Cargando /> : (
                <Tabla
                  cols={COLS_PLAN}
                  ancho={760}
                  cabeceras={[
                    { label: 'Plan' }, { label: '× sesión' }, { label: '× semana' },
                    { label: 'Créditos / sesión', num: true }, { label: 'Créditos / semana', num: true },
                    { label: '', key: 'acciones' },
                  ]}
                >
                  {planes.map((p) => (
                    <Fila key={p.id} cols={COLS_PLAN}>
                      <Celda><span className="adm-lista__label">{p.name}</span></Celda>
                      <Celda>
                        <input
                          className="adm-input adm-input--mono adm-input--sm"
                          inputMode="decimal"
                          aria-label={`Multiplicador de sesión de ${p.name}`}
                          value={multiplicadores[p.id]?.session ?? ''}
                          onChange={(e) => setMultiplicadores({
                            ...multiplicadores, [p.id]: { ...multiplicadores[p.id], session: e.target.value },
                          })}
                        />
                      </Celda>
                      <Celda>
                        <input
                          className="adm-input adm-input--mono adm-input--sm"
                          inputMode="decimal"
                          aria-label={`Multiplicador semanal de ${p.name}`}
                          value={multiplicadores[p.id]?.week ?? ''}
                          onChange={(e) => setMultiplicadores({
                            ...multiplicadores, [p.id]: { ...multiplicadores[p.id], week: e.target.value },
                          })}
                        />
                      </Celda>
                      <Celda num><span className="mono">{cupo(baseSesion, multiplicadores[p.id]?.session)}</span></Celda>
                      <Celda num><span className="mono">{cupo(baseSemana, multiplicadores[p.id]?.week)}</span></Celda>
                      <Celda acciones>
                        <Boton sm variante="primary" onClick={() => guardarMultiplicadores(p.id)}>
                          {guardado === `mult-${p.id}` ? 'Guardado' : 'Guardar'}
                        </Boton>
                      </Celda>
                    </Fila>
                  ))}
                </Tabla>
              )}
              <p className="adm-card__nota">
                El cupo de cada plan es la base por su multiplicador. Las dos últimas columnas
                lo calculan con lo que hay escrito, antes de guardar.
              </p>
            </Tarjeta>
          </>
        )}

        {seccion === 'pesos' && (
          <TablaPorModelo
            titulo="Créditos que gasta cada modelo"
            nota={<>Créditos por millón de tokens que se descuentan del cupo de sesión y semana. No es dinero: el cobro en USD está en «Precios de API». La fila <span className="mono">*</span> es el peso por defecto.</>}
            unidad="Créditos"
            entero
            filas={pesos}
            borrador={borradorPesos}
            setBorrador={setBorradorPesos}
            guardadoId={(f) => guardado === `peso-${f.id}`}
            onGuardar={guardarPeso}
            onAlternar={alternarPeso}
            onEliminar={eliminarPeso}
            estado={(activo) => (activo ? 'Activo' : 'Pausado')}
            alta={{
              abierta: altaAbierta,
              setAbierta: setAltaAbierta,
              valor: nuevoPeso,
              setValor: setNuevoPeso,
              ejemplo: ['1000000', '4000000'],
              etiqueta: 'Añadir peso',
              onCrear: crearPeso,
              busy,
            }}
          />
        )}

        {seccion === 'api' && (
          <TablaPorModelo
            titulo="Precio por millón de tokens (USD)"
            nota={<>Lo que paga el tráfico de API externo con créditos prepago. El costo se congela al cobrar: editar una tarifa solo afecta a las peticiones nuevas. La fila <span className="mono">*</span> es la tarifa por defecto.</>}
            unidad="$"
            filas={filas}
            borrador={borrador}
            setBorrador={setBorrador}
            guardadoId={(f) => guardado === f.id}
            onGuardar={guardar}
            onAlternar={alternar}
            onEliminar={eliminar}
            estado={(activo) => (activo ? 'Activa' : 'Pausada')}
            alta={{
              abierta: altaAbierta,
              setAbierta: setAltaAbierta,
              valor: nueva,
              setValor: setNueva,
              ejemplo: ['0.45', '1.20'],
              etiqueta: 'Añadir tarifa',
              onCrear: crear,
              busy,
            }}
          />
        )}

        {seccion === 'stripe' && (
          <Tarjeta titulo="Price id de cada plan de pago" tabla>
            {planes.length === 0 ? <Cargando /> : (
              <Tabla
                cols={COLS_STRIPE}
                ancho={560}
                cabeceras={[{ label: 'Plan' }, { label: 'Price id' }, { label: '', key: 'acciones' }]}
              >
                {planes.filter((p) => p.price_monthly_cents > 0).map((p) => (
                  <Fila key={p.id} cols={COLS_STRIPE}>
                    <Celda><span className="adm-lista__label">{p.name}</span></Celda>
                    <Celda>
                      <input
                        className="adm-input adm-input--mono adm-input--sm"
                        placeholder="price_…"
                        aria-label={`Price id de ${p.name}`}
                        value={precios[p.id] ?? ''}
                        onChange={(e) => setPrecios({ ...precios, [p.id]: e.target.value })}
                      />
                    </Celda>
                    <Celda acciones>
                      <Boton sm variante="primary" onClick={() => guardarPrecio(p.id)}>
                        {guardado === `precio-${p.id}` ? 'Guardado' : 'Guardar'}
                      </Boton>
                    </Celda>
                  </Fila>
                ))}
              </Tabla>
            )}
            <p className="adm-card__nota">
              Se crea en Stripe → Productos y es lo que conecta el plan con el checkout. El plan
              gratuito no lleva.
            </p>
          </Tarjeta>
        )}
      </div>
    </>
  );
}

// Pesos y tarifas tienen la misma forma (prefijo, nombre, entrada, salida,
// estado): una sola tabla con el alta plegada en la cabecera.
function TablaPorModelo({
  titulo, nota, unidad, entero, filas, borrador, setBorrador, guardadoId,
  onGuardar, onAlternar, onEliminar, estado, alta,
}) {
  const modo = entero ? 'numeric' : 'decimal';
  const cabeceras = [
    { label: 'Prefijo' }, { label: 'Nombre' },
    { label: `${unidad} entrada / Mtok` }, { label: `${unidad} salida / Mtok` },
    { label: 'Estado' }, { label: '', key: 'acciones' },
  ];
  const cambiar = (id, campo, v) => setBorrador({ ...borrador, [id]: { ...borrador[id], [campo]: v } });
  const nuevo = alta.valor;
  const poner = (campo) => (e) => alta.setValor({ ...nuevo, [campo]: e.target.value });

  return (
    <Tarjeta
      titulo={titulo}
      tabla
      extra={!alta.abierta && (
        <Boton sm onClick={() => alta.setAbierta(true)}>
          <IconPlus size={13} /> {alta.etiqueta}
        </Boton>
      )}
    >
      {alta.abierta && (
        <form
          className="adm-alta"
          onSubmit={(e) => { e.preventDefault(); if (nuevo.model_prefix.trim()) alta.onCrear(); }}
        >
          <label className="adm-campo">
            <span className="adm-campo__label">Prefijo del modelo</span>
            <input className="adm-input adm-input--mono" placeholder="qwen2.5" autoFocus value={nuevo.model_prefix} onChange={poner('model_prefix')} />
          </label>
          <label className="adm-campo">
            <span className="adm-campo__label">Nombre visible (opcional)</span>
            <input className="adm-input" placeholder="Qwen 2.5" value={nuevo.display_name} onChange={poner('display_name')} />
          </label>
          <label className="adm-campo">
            <span className="adm-campo__label">{unidad} entrada / Mtok</span>
            <input className="adm-input adm-input--mono" inputMode={modo} placeholder={alta.ejemplo[0]} value={nuevo.input} onChange={poner('input')} />
          </label>
          <label className="adm-campo">
            <span className="adm-campo__label">{unidad} salida / Mtok</span>
            <input className="adm-input adm-input--mono" inputMode={modo} placeholder={alta.ejemplo[1]} value={nuevo.output} onChange={poner('output')} />
          </label>
          <div className="adm-alta__acciones">
            <button type="submit" className="adm-btn adm-btn--primary" disabled={alta.busy || !nuevo.model_prefix.trim()}>
              <IconPlus size={15} /> {alta.etiqueta}
            </button>
            <Boton aria-label="Cancelar" onClick={() => alta.setAbierta(false)}>
              <IconX size={15} />
            </Boton>
          </div>
        </form>
      )}

      {filas === null || filas === undefined ? <Cargando /> : filas.length === 0 ? (
        <Vacio>Todavía no hay ninguna fila.</Vacio>
      ) : (
        <Tabla cols={COLS} cabeceras={cabeceras} ancho={860}>
          {filas.map((f) => (
            <Fila key={f.id} cols={COLS}>
              <Celda><span className="mono">{f.model_prefix}</span></Celda>
              <Celda><span className="adm-lista__label">{f.display_name || '—'}</span></Celda>
              <Celda>
                <input
                  className="adm-input adm-input--mono adm-input--sm"
                  inputMode={modo}
                  aria-label={`Entrada de ${f.model_prefix}`}
                  value={borrador[f.id]?.input ?? ''}
                  onChange={(e) => cambiar(f.id, 'input', e.target.value)}
                />
              </Celda>
              <Celda>
                <input
                  className="adm-input adm-input--mono adm-input--sm"
                  inputMode={modo}
                  aria-label={`Salida de ${f.model_prefix}`}
                  value={borrador[f.id]?.output ?? ''}
                  onChange={(e) => cambiar(f.id, 'output', e.target.value)}
                />
              </Celda>
              <Celda>
                <button type="button" className="adm-chip-btn" onClick={() => onAlternar(f)}>
                  <Chip tono={f.is_active ? 'ok' : 'off'} punto>{estado(f.is_active)}</Chip>
                </button>
              </Celda>
              <Celda acciones>
                <Boton sm variante="primary" onClick={() => onGuardar(f)}>
                  {guardadoId(f) ? 'Guardado' : 'Guardar'}
                </Boton>
                {f.model_prefix === '*' ? <span className="adm-acciones__hueco" /> : (
                  <Boton sm peligro aria-label={`Eliminar ${f.model_prefix}`} onClick={() => onEliminar(f)}>
                    <IconTrash size={13} />
                  </Boton>
                )}
              </Celda>
            </Fila>
          ))}
        </Tabla>
      )}
      <p className="adm-card__nota">{nota}</p>
    </Tarjeta>
  );
}
