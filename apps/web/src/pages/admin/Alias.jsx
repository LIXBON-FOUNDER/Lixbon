// Alias.jsx — nombre público de cada modelo. Con un alias definido, los
// usuarios ven "Lixbon 1" (id `lixbon-1`) y nunca el nombre del proveedor; los
// modelos sin alias desaparecen de su catálogo.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useConfirmar } from '../../hooks/useConfirmar';
import { IconCheck, IconPlus, IconRefresh, IconTrash } from '../../components/Icons';
import { Select } from '../../components/Select';
import {
  Aviso, Boton, Cabecera, Cargando, Chip, Tarjeta, errMsg,
} from './comunes';

const NUEVO = { alias: '', name: '', model: '', description: '' };

const slug = (name) => name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export default function Alias() {
  const confirmar = useConfirmar();
  const [data, setData] = useState(null);
  const [filas, setFilas] = useState([]);
  const [nuevo, setNuevo] = useState(NUEVO);
  const [guardado, setGuardado] = useState(null);
  const [error, setError] = useState('');

  const cargar = useCallback(async () => {
    try {
      const r = await api.get('/api/admin/model-aliases');
      setData(r.data);
      setFilas(r.data.aliases.map((a) => ({ ...a, description: a.description || '' })));
    } catch (e) {
      setError(errMsg(e, 'No se pudieron cargar los alias'));
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const guardar = async (fila, esNuevo = false) => {
    setError('');
    const alias = (fila.alias || slug(fila.name)).trim();
    try {
      await api.put(`/api/admin/model-aliases/${encodeURIComponent(alias)}`, {
        name: fila.name, model: fila.model, description: fila.description,
        sort_order: fila.sort_order ?? 0, is_active: fila.is_active ?? true,
      });
      setGuardado(alias);
      setTimeout(() => setGuardado(null), 2500);
      if (esNuevo) setNuevo(NUEVO);
      cargar();
    } catch (e) {
      setError(errMsg(e, 'No se pudo guardar el alias'));
    }
  };

  const borrar = async (alias) => {
    const ok = await confirmar({
      titulo: `¿Eliminar el alias ${alias}?`,
      texto: 'Los clientes que lo tengan elegido dejarán de encontrarlo; el modelo real sigue disponible.',
      etiqueta: 'Eliminar',
      peligro: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/api/admin/model-aliases/${encodeURIComponent(alias)}`);
      cargar();
    } catch (e) {
      setError(errMsg(e, 'No se pudo eliminar'));
    }
  };

  if (!data && !error) {
    return (
      <>
        <Cabecera titulo="Alias" />
        <div className="adm__body"><Cargando /></div>
      </>
    );
  }

  const modelos = (data?.models || []).filter((m) => !String(m.id).startsWith('error:'));
  const opciones = (actual) => [
    { value: '', label: '— elige un modelo —' },
    ...modelos.map((m) => ({ value: m.id, label: m.id })),
    ...(actual && !modelos.some((m) => m.id === actual) ? [{ value: actual, label: `${actual} (no instalado)` }] : []),
  ];

  const formulario = (fila, onChange, esNuevo = false) => (
    <div className="adm-campos">
      <label className="adm-campo">
        <span className="adm-campo__label">Nombre visible</span>
        <input className="adm-input" placeholder="Lixbon 1" value={fila.name}
          onChange={(e) => onChange({ ...fila, name: e.target.value, ...(esNuevo && !fila.aliasTocado ? { alias: slug(e.target.value) } : {}) })} />
      </label>
      <label className="adm-campo">
        <span className="adm-campo__label">Id público</span>
        <input className="adm-input adm-input--mono" placeholder="lixbon-1" value={fila.alias} disabled={!esNuevo}
          onChange={(e) => onChange({ ...fila, alias: e.target.value, aliasTocado: true })} />
      </label>
      <label className="adm-campo adm-campo__ancho">
        <span className="adm-campo__label">Modelo real</span>
        <Select className="adm-select adm-input--mono" value={fila.model}
          onChange={(v) => onChange({ ...fila, model: v })} options={opciones(fila.model)} />
      </label>
      <label className="adm-campo adm-campo__ancho">
        <span className="adm-campo__label">Descripción (opcional)</span>
        <input className="adm-input" placeholder="Para código y documentos largos" value={fila.description}
          onChange={(e) => onChange({ ...fila, description: e.target.value })} />
      </label>
    </div>
  );

  return (
    <>
      <Cabecera
        titulo="Alias"
        lead="Cómo se llama cada modelo de cara a los usuarios. Con al menos un alias, los modelos sin alias dejan de aparecerles."
      >
        <Boton onClick={cargar}><IconRefresh size={15} /> Recargar</Boton>
      </Cabecera>

      <div className="adm__body">
        <Aviso error>{error}</Aviso>

        <div className="adm-roles">
          {filas.map((fila, i) => (
            <Tarjeta key={fila.alias}>
              <div className="adm-card__head">
                <div className="adm-detalle__nombre">
                  <span className="adm-card__title">{fila.name}</span>
                  <span className="adm-detalle__sub mono">{fila.alias} → {fila.model}</span>
                </div>
                <Chip tono={modelos.some((m) => m.id === fila.model) ? 'ok' : 'warn'} punto>
                  {modelos.some((m) => m.id === fila.model) ? 'servido' : 'sin nodo'}
                </Chip>
              </div>
              {formulario(fila, (f) => setFilas(filas.map((x, j) => (j === i ? f : x))))}
              <div className="adm-card__pie">
                <Boton peligro onClick={() => borrar(fila.alias)}><IconTrash size={15} /> Eliminar</Boton>
                <Boton variante="primary" onClick={() => guardar(fila)}>
                  <IconCheck size={15} /> {guardado === fila.alias ? 'Guardado' : 'Guardar'}
                </Boton>
              </div>
            </Tarjeta>
          ))}

          <Tarjeta titulo="Nuevo alias">
            {formulario(nuevo, setNuevo, true)}
            <div className="adm-card__pie">
              <span />
              <Boton variante="primary" disabled={!nuevo.name || !nuevo.model} onClick={() => guardar(nuevo, true)}>
                <IconPlus size={15} /> Crear
              </Boton>
            </div>
          </Tarjeta>
        </div>

        <Tarjeta titulo="Cómo se lee esta página">
          <p className="adm-card__nota">
            El <strong>id público</strong> es lo que usan la API, el CLI (<span className="mono">/model lixbon-1</span>)
            y el IDE; el <strong>nombre visible</strong> es lo que ve la gente en los selectores. El gateway traduce al
            modelo real al enrutar; las tarifas y los roles siguen apuntando al modelo real.
          </p>
        </Tarjeta>
      </div>
    </>
  );
}
