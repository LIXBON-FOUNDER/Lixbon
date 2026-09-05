import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { planBadge } from '../../lib/planColors';
import { IconChart, IconCheck, IconPencil, IconRefresh, IconX } from '../../components/Icons';
import {
  Aviso, Boton, Cabecera, Cargando, Tarjeta, Vacio,
  errMsg, fmtTokens, nombrePlan, tintaDe,
} from './comunes';

// Misma regla que usa el gateway al cobrar: gana el prefijo más largo que
// encaje, y si ninguno encaja, la fila `*`.
function tarifaDe(pricing, modelId) {
  const propias = pricing
    .filter((r) => r.model_prefix !== '*' && modelId.startsWith(r.model_prefix))
    .sort((a, b) => b.model_prefix.length - a.model_prefix.length);
  return propias[0] || pricing.find((r) => r.model_prefix === '*') || null;
}

const precio = (r) => (r
  ? `$${r.input_usd_per_mtok} · $${r.output_usd_per_mtok} / M tok`
  : 'sin tarifa');

function PlanModelos({ plan, modelos, onGuardar, guardado }) {
  const [prefijos, setPrefijos] = useState(plan.allowed_models || []);
  const [anadiendo, setAnadiendo] = useState(false);
  const [texto, setTexto] = useState('');

  useEffect(() => { setPrefijos(plan.allowed_models || []); }, [plan.allowed_models]);

  const aplicar = (lista) => {
    setPrefijos(lista);
    onGuardar(plan.id, lista);
  };

  const anadir = (valor) => {
    const v = valor.trim();
    setTexto('');
    setAnadiendo(false);
    if (!v || prefijos.includes(v)) return;
    aplicar([...prefijos, v]);
  };

  return (
    <div className="adm-plan-fila">
      <span
        className="adm-chip"
        style={{ background: planBadge(plan.id).bg, color: planBadge(plan.id).ink }}
      >
        {nombrePlan(plan.id)}
      </span>
      <div className="adm-chips">
        {prefijos.length === 0 && (
          <span className="adm-chip adm-chip--off">todos los modelos</span>
        )}
        {prefijos.map((p) => (
          <span key={p} className="adm-chip adm-chip--mono">
            {p}
            <button
              type="button"
              className="adm-chip__x"
              aria-label={`Quitar ${p} de ${plan.name}`}
              onClick={() => aplicar(prefijos.filter((x) => x !== p))}
            >
              <IconX size={11} />
            </button>
          </span>
        ))}
        {anadiendo ? (
          <input
            className="adm-chip-input"
            autoFocus
            list={`modelos-${plan.id}`}
            value={texto}
            placeholder="prefijo"
            onChange={(e) => setTexto(e.target.value)}
            onBlur={(e) => anadir(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); anadir(texto); }
              if (e.key === 'Escape') { setTexto(''); setAnadiendo(false); }
            }}
          />
        ) : (
          <button type="button" className="adm-chip-add" onClick={() => setAnadiendo(true)}>
            añadir
          </button>
        )}
        <datalist id={`modelos-${plan.id}`}>
          {modelos.map((m) => <option key={m.id} value={m.id} />)}
        </datalist>
        {guardado && <span className="adm-chip adm-chip--ok"><IconCheck size={11} /> guardado</span>}
      </div>
    </div>
  );
}

function PanelModelo({ modelo, tinta, tarifa, tokens, onRecargar, onError }) {
  const [entrada, setEntrada] = useState('');
  const [salida, setSalida] = useState('');
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState('');

  useEffect(() => {
    setEntrada(tarifa ? String(tarifa.input_usd_per_mtok) : '');
    setSalida(tarifa ? String(tarifa.output_usd_per_mtok) : '');
    setOk('');
  }, [tarifa, modelo.id]);

  const porDefecto = !tarifa || tarifa.model_prefix === '*';

  const guardar = async () => {
    setBusy(true);
    onError('');
    try {
      await api.patch(`/api/admin/pricing/${tarifa.id}`, {
        input_usd_per_mtok: parseFloat(entrada) || 0,
        output_usd_per_mtok: parseFloat(salida) || 0,
      });
      setOk('Tarifa guardada.');
      setTimeout(() => setOk(''), 2500);
      onRecargar();
    } catch (e) {
      onError(errMsg(e, 'No se pudo guardar la tarifa'));
    } finally {
      setBusy(false);
    }
  };

  const crearPropia = async () => {
    setBusy(true);
    onError('');
    try {
      await api.post('/api/admin/pricing', {
        model_prefix: modelo.id,
        display_name: null,
        input_usd_per_mtok: parseFloat(entrada) || 0,
        output_usd_per_mtok: parseFloat(salida) || 0,
      });
      onRecargar();
    } catch (e) {
      onError(errMsg(e, 'No se pudo crear la tarifa'));
    } finally {
      setBusy(false);
    }
  };

  const alternarPausa = async () => {
    setBusy(true);
    onError('');
    try {
      await api.patch(`/api/admin/pricing/${tarifa.id}`, { is_active: !tarifa.is_active });
      onRecargar();
    } catch (e) {
      onError(errMsg(e, 'No se pudo cambiar el estado de la tarifa'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="adm-detalle">
      <div className="adm-detalle__cab">
        <span className="adm-detalle__icono" style={{ color: tinta }}><IconChart size={18} /></span>
        <div className="adm-detalle__nombre">
          <span className="adm-detalle__id">{modelo.id}</span>
          <span className="adm-detalle__sub">
            Ollama · {modelo.nodes.length} {modelo.nodes.length === 1 ? 'nodo' : 'nodos'}
          </span>
        </div>
      </div>

      <div className="adm-lista">
        <div className="adm-lista__fila">
          <span className="adm-lista__label">Nodos que lo sirven</span>
          <span className="adm-lista__valor">{modelo.nodes.join(', ') || '—'}</span>
        </div>
        <div className="adm-lista__fila">
          <span className="adm-lista__label">Tokens este mes</span>
          <span className="adm-lista__valor">{tokens != null ? fmtTokens(tokens) : '—'}</span>
        </div>
        <div className="adm-lista__fila">
          <span className="adm-lista__label">Planes que lo incluyen</span>
          <span className="adm-lista__valor">{modelo.plans.join(', ') || '—'}</span>
        </div>
        <div className="adm-lista__fila">
          <span className="adm-lista__label">Prefijo de la tarifa</span>
          <span className="adm-lista__valor">{tarifa ? tarifa.model_prefix : '—'}</span>
        </div>
      </div>

      <div className="adm-bloque">
        <span className="adm-bloque__label">Tarifa por millón de tokens</span>
        <div className="adm-par">
          <label className="adm-campo">
            <span className="adm-campo__label">Entrada</span>
            <input
              className="adm-input adm-input--mono"
              inputMode="decimal"
              value={entrada}
              onChange={(e) => setEntrada(e.target.value)}
            />
          </label>
          <label className="adm-campo">
            <span className="adm-campo__label">Salida</span>
            <input
              className="adm-input adm-input--mono"
              inputMode="decimal"
              value={salida}
              onChange={(e) => setSalida(e.target.value)}
            />
          </label>
        </div>
        <p className="adm-card__nota">
          {porDefecto
            ? 'Este modelo se cobra con la tarifa por defecto (*), que comparte con todos los que no tienen la suya. Guardar aquí crearía una tarifa propia para este modelo.'
            : 'El costo se congela al cobrar: cambiar la tarifa no recalcula lo ya facturado.'}
        </p>
      </div>

      <Aviso>{ok}</Aviso>

      <div className="adm-card__pie">
        {!porDefecto && (
          <Boton disabled={busy} onClick={alternarPausa}>
            {tarifa.is_active ? 'Pausar' : 'Reactivar'}
          </Boton>
        )}
        <Boton
          variante="primary"
          disabled={busy || !entrada}
          onClick={porDefecto ? crearPropia : guardar}
        >
          <IconCheck size={15} />
          {porDefecto ? 'Crear tarifa propia' : 'Guardar tarifa'}
        </Boton>
      </div>
    </div>
  );
}

export default function Modelos() {
  const [data, setData] = useState(null);
  const [pricing, setPricing] = useState([]);
  const [uso, setUso] = useState({});
  const [sel, setSel] = useState(null);
  const [guardado, setGuardado] = useState('');
  const [error, setError] = useState('');

  const cargar = useCallback(async () => {
    try {
      const [modelos, tarifas] = await Promise.all([
        api.get('/api/admin/models'),
        api.get('/api/admin/pricing'),
      ]);
      setData(modelos.data);
      setPricing(tarifas.data.pricing);
    } catch (e) {
      setError(errMsg(e, 'No se pudieron cargar los modelos'));
    }
  }, []);

  useEffect(() => {
    cargar();
    // /models no trae consumo: sale del resumen de créditos.
    api.get('/api/admin/credits/summary')
      .then((r) => setUso(Object.fromEntries(
        (r.data.usage_by_model || []).map((x) => [x.model, x.tokens]),
      )))
      .catch(() => {});
  }, [cargar]);

  const modelos = useMemo(() => data?.models || [], [data]);
  const planes = data?.plans || [];

  useEffect(() => {
    if (!sel && modelos.length > 0) setSel(modelos[0].id);
  }, [modelos, sel]);

  const guardarPlan = async (planId, lista) => {
    setError('');
    try {
      await api.patch(`/api/admin/plans/${planId}`, { allowed_models: lista });
      setGuardado(planId);
      setTimeout(() => setGuardado(''), 2500);
    } catch (e) {
      setError(errMsg(e, 'No se pudieron guardar los modelos del plan'));
    }
  };

  const elegido = useMemo(
    () => modelos.find((m) => m.id === sel) || null,
    [modelos, sel],
  );
  const indice = modelos.findIndex((m) => m.id === sel);

  return (
    <>
      <Cabecera
        titulo="Modelos y costo"
        lead="Qué modelo sirve cada petición y a qué precio se cobra el crédito de API."
      >
        <Boton onClick={cargar}><IconRefresh size={15} /> Sincronizar con nodos</Boton>
      </Cabecera>

      <div className="adm__body">
        <Aviso error>{error}</Aviso>

        {!data ? <Cargando /> : (
          <div className="adm-ia">
            <div className="adm-columna">
              <Tarjeta>
                <div className="adm-tabla__cabecera adm-modelo" style={{ padding: '0 14px 2px' }}>
                  <span className="adm-tabla__th">Modelos</span>
                  <span className="adm-tabla__th">Consumo</span>
                  <span className="adm-tabla__th">Tarifa</span>
                </div>

                {modelos.length === 0 ? (
                  <Vacio>Sin nodos en línea: ahora mismo no hay modelos visibles.</Vacio>
                ) : (
                  <div className="adm-modelos">
                    {modelos.map((m, i) => {
                      const t = tarifaDe(pricing, m.id);
                      return (
                        <div
                          key={m.id}
                          className={`adm-modelo ${sel === m.id ? 'is-activo' : ''}`}
                        >
                          <button
                            type="button"
                            className="adm-modelo__celda"
                            onClick={() => setSel(m.id)}
                            aria-pressed={sel === m.id}
                          >
                            <span className="adm-modelo__nombre">
                              <span className="adm-modelo__marca" style={{ color: tintaDe(i) }}>
                                <IconChart size={17} />
                              </span>
                              <span className="adm-modelo__id">{m.id}</span>
                            </span>
                          </button>
                          <div className="adm-modelo__celda">
                            <span className="adm-modelo__uso">
                              Tokens <strong className="mono">{uso[m.id] != null ? fmtTokens(uso[m.id]) : '—'}</strong>
                            </span>
                          </div>
                          <div className="adm-modelo__celda">
                            <span className="adm-modelo__tarifa">
                              {t && !t.is_active ? 'pausada · ' : ''}{precio(t)}
                            </span>
                            <Boton sm variante="primary" onClick={() => setSel(m.id)}>
                              Editar <IconPencil size={14} />
                            </Boton>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Tarjeta>

              <Tarjeta titulo="Modelos permitidos por plan">
                <p className="adm-card__nota">
                  Se compara por prefijo del id del modelo. Sin ningún prefijo, el plan
                  incluye todos los modelos del clúster.
                </p>
                {planes.map((p) => (
                  <PlanModelos
                    key={p.id}
                    plan={p}
                    modelos={modelos}
                    guardado={guardado === p.id}
                    onGuardar={guardarPlan}
                  />
                ))}
              </Tarjeta>
            </div>

            {elegido ? (
              <PanelModelo
                modelo={elegido}
                tinta={tintaDe(indice)}
                tarifa={tarifaDe(pricing, elegido.id)}
                tokens={uso[elegido.id]}
                onRecargar={cargar}
                onError={setError}
              />
            ) : (
              <div className="adm-detalle">
                <Vacio>Elige un modelo para ver su tarifa.</Vacio>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
