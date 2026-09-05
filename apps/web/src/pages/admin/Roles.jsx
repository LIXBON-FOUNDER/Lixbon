// Modelo vacío no es "ninguno": es "que lo decida el gateway", por variable de
// entorno o por la capacidad que declara Ollama. Por eso cada rol enseña qué
// acabó resolviendo y de dónde salió.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { IconCheck, IconRefresh } from '../../components/Icons';
import {
  Aviso, Boton, Cabecera, Cargando, Chip, Tarjeta, errMsg,
} from './comunes';

const ROL_NOMBRE = {
  chat: 'Chat y agente',
  fim: 'Autocompletado (FIM)',
  vision: 'Visión',
  embed: 'Embeddings',
  route: 'Delegación y títulos',
};

const ORIGEN = {
  db: 'fijado aquí',
  env: 'variable de entorno',
  capability: 'autodetectado',
  'capability-legacy': 'autodetectado (nodo sin capabilities)',
  none: 'sin resolver',
};

export default function Roles() {
  const [data, setData] = useState(null);
  const [borrador, setBorrador] = useState({});
  const [todos, setTodos] = useState({});
  const [guardado, setGuardado] = useState(null);
  const [error, setError] = useState('');

  const cargar = useCallback(async () => {
    try {
      const r = await api.get('/api/admin/model-roles');
      setData(r.data);
      setBorrador(Object.fromEntries(r.data.roles.map((x) => [x.role, {
        model: x.model || '',
        keep_alive: x.keep_alive || '',
        num_ctx: x.num_ctx ? String(x.num_ctx) : '',
      }])));
    } catch (e) {
      setError(errMsg(e, 'No se pudieron cargar los roles'));
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const guardar = async (rol, { force = false } = {}) => {
    setError('');
    const d = borrador[rol] || {};
    try {
      await api.patch(`/api/admin/model-roles/${rol}`, {
        model: d.model ?? '',
        keep_alive: d.keep_alive ?? '',
        num_ctx: d.num_ctx ? parseInt(d.num_ctx, 10) : 0,
        force,
      });
      setGuardado(rol);
      setTimeout(() => setGuardado(null), 2500);
      cargar();
    } catch (e) {
      const detalle = e.response?.data?.detail;
      if (detalle?.code === 'capability_mismatch') {
        if (window.confirm(`${detalle.message}\n\n¿Asignarlo igualmente?`)) {
          guardar(rol, { force: true });
        }
        return;
      }
      setError(errMsg(e, 'No se pudo guardar el rol'));
    }
  };

  if (!data && !error) {
    return (
      <>
        <Cabecera titulo="Roles" />
        <div className="adm__body"><Cargando /></div>
      </>
    );
  }

  const modelos = data?.models || [];

  // Capabilities ausentes = node_agent viejo, no incompatible: no se descartan.
  const opciones = (rol) => {
    const necesaria = data.capability_by_role[rol];
    if (todos[rol]) return modelos;
    return modelos.filter((m) => !m.capabilities || m.capabilities.includes(necesaria));
  };

  return (
    <>
      <Cabecera
        titulo="Roles"
        lead="Qué modelo atiende cada trabajo. Los cambios aplican en menos de un minuto."
      >
        <Boton onClick={cargar}><IconRefresh size={15} /> Recargar</Boton>
      </Cabecera>

      <div className="adm__body">
        <Aviso error>{error}</Aviso>

        {data && (
          <>
            <div className="adm-roles">
              {data.roles.map((r) => {
                const res = data.resolved[r.role] || {};
                const d = borrador[r.role] || {};
                return (
                  <Tarjeta key={r.role}>
                    <div className="adm-card__head">
                      <div className="adm-detalle__nombre">
                        <span className="adm-card__title">{ROL_NOMBRE[r.role] || r.role}</span>
                        <span className="adm-detalle__sub mono">{r.role}</span>
                      </div>
                      <Chip mono>{data.capability_by_role[r.role]}</Chip>
                    </div>

                    <div className="adm-campos">
                      <label className="adm-campo adm-campo__ancho">
                        <span className="adm-campo__label">Modelo</span>
                        <select
                          className="adm-select adm-input--mono"
                          value={d.model ?? ''}
                          onChange={(e) => setBorrador({
                            ...borrador, [r.role]: { ...d, model: e.target.value },
                          })}
                        >
                          <option value="">— automático —</option>
                          {opciones(r.role).map((m) => (
                            <option key={m.id} value={m.id}>{m.id}</option>
                          ))}
                          {d.model && !modelos.some((m) => m.id === d.model) && (
                            <option value={d.model}>{d.model} (no instalado)</option>
                          )}
                        </select>
                      </label>
                      <label className="adm-campo">
                        <span className="adm-campo__label">keep_alive</span>
                        <input
                          className="adm-input adm-input--mono"
                          placeholder="auto"
                          value={d.keep_alive ?? ''}
                          onChange={(e) => setBorrador({
                            ...borrador, [r.role]: { ...d, keep_alive: e.target.value },
                          })}
                        />
                      </label>
                      <label className="adm-campo">
                        <span className="adm-campo__label">num_ctx</span>
                        <input
                          className="adm-input adm-input--mono"
                          placeholder="auto"
                          value={d.num_ctx ?? ''}
                          onChange={(e) => setBorrador({
                            ...borrador, [r.role]: { ...d, num_ctx: e.target.value },
                          })}
                        />
                      </label>
                    </div>

                    <div className="adm-lista">
                      <div className="adm-lista__fila">
                        <span className="adm-lista__label">Resuelto</span>
                        <span className="adm-lista__valor">
                          {res.model || 'sin modelo'}
                          {res.model && (
                            <span className="adm-detalle__sub"> · {ORIGEN[res.source] || res.source}</span>
                          )}
                        </span>
                      </div>
                    </div>

                    {res.warning && (
                      <p className="adm-card__nota" role="status">⚠ {res.warning}</p>
                    )}

                    <div className="adm-card__pie">
                      <Boton
                        onClick={() => setTodos({ ...todos, [r.role]: !todos[r.role] })}
                      >
                        {todos[r.role] ? 'Solo compatibles' : 'Mostrar todos'}
                      </Boton>
                      <Boton variante="primary" onClick={() => guardar(r.role)}>
                        <IconCheck size={15} />
                        {guardado === r.role ? 'Guardado' : 'Guardar'}
                      </Boton>
                    </div>
                  </Tarjeta>
                );
              })}
            </div>

            <Tarjeta titulo="Cómo se lee esta página">
              <p className="adm-card__nota">
                <strong>keep_alive</strong> es cuánto se queda el modelo cargado en la VRAM:
                <span className="mono"> 30m</span>, <span className="mono">-1</span> permanente,
                <span className="mono"> 0</span> descargar al terminar. Con una sola GPU no
                pongas <span className="mono">-1</span> en el rol de chat: bloquea la tarjeta
                para todo lo demás. <strong>num_ctx</strong> es el contexto en tokens; vacío
                deja el que trae el modelo.
              </p>
            </Tarjeta>
          </>
        )}
      </div>
    </>
  );
}
