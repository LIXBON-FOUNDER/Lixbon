import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import {
  IconCheck, IconPlus, IconRefresh, IconTrash, IconX,
} from '../../components/Icons';
import {
  Aviso, Boton, Cabecera, Cargando, Chip, Medida, Nota, Tarjeta, Vacio,
  errMsg, fmtHace,
} from './comunes';

// "Aislado" lo decidió el circuit breaker; "sin responder" es un nodo mudo.
function estadoDe(st) {
  if (!st) return { tono: 'off', texto: 'Sin datos' };
  if (st.online) return { tono: 'ok', texto: 'En línea' };
  if (st.circuit_breaker) return { tono: 'bad', texto: 'Aislado' };
  return { tono: 'warn', texto: 'Sin responder' };
}

const pct = (v) => (typeof v === 'number' ? `${Math.round(v)}%` : '—');

function TarjetaNodo({ nodo, st, onReintentar, onEditar, onEliminar, reintentando }) {
  const e = estadoDe(st);
  const m = st?.metricas || {};
  // El agente reporta GPU libre; aquí se mira la ocupada.
  const vram = typeof m.gpu_free_percent === 'number' ? 100 - m.gpu_free_percent : null;

  return (
    <article className={`adm-nodo ${e.tono === 'bad' ? 'is-caido' : ''}`}>
      <div className="adm-nodo__top">
        <div className="adm-nodo__id">
          <div className="adm-nodo__nombre">
            <span className="adm-nodo__slug">{nodo.id}</span>
            <Chip tono={e.tono} punto>{e.texto}</Chip>
          </div>
          <span className="adm-nodo__url">{nodo.agent_url}</span>
          <span className="adm-nodo__url">
            {nodo.name}
            {st?.seconds_ago != null && ` · visto ${fmtHace(st.seconds_ago)}`}
          </span>
        </div>
      </div>

      <div className="adm-nodo__score">
        <span className="adm-nodo__score-label">Score</span>
        <span className="adm-nodo__score-valor">
          {typeof st?.score === 'number' ? st.score.toFixed(2).replace('.', ',') : '—'}
        </span>
        {st?.fallos > 0 && (
          <span className="adm-detalle__sub">
            {st.fallos} {st.fallos === 1 ? 'fallo' : 'fallos'}
          </span>
        )}
      </div>

      <div className="adm-medidas">
        <Medida label="CPU" valor={pct(m.cpu_percent)} pct={m.cpu_percent} />
        <Medida label="RAM" valor={pct(m.ram_percent)} pct={m.ram_percent} />
        <Medida label="VRAM" valor={pct(vram)} pct={vram} />
      </div>

      {st?.modelos?.length > 0 && (
        <div className="adm-chips">
          {st.modelos.slice(0, 4).map((x) => <Chip key={x} mono>{x}</Chip>)}
          {st.modelos.length > 4 && <Chip>+{st.modelos.length - 4}</Chip>}
        </div>
      )}

      <div className="adm-card__pie">
        {st && !st.online && (
          <Boton sm disabled={reintentando} onClick={() => onReintentar(nodo.id)}>
            <IconRefresh size={13} /> {reintentando ? 'Reintentando…' : 'Reintentar'}
          </Boton>
        )}
        <Boton sm onClick={() => onEditar(nodo)}>Editar</Boton>
        <Boton sm peligro onClick={() => onEliminar(nodo.id)}>
          <IconTrash size={13} /> Eliminar
        </Boton>
      </div>
    </article>
  );
}

export default function Nodos() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null); // null = cerrado; {} = alta
  const [token, setToken] = useState(null);
  const [reintentando, setReintentando] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const cargar = useCallback(() => {
    api.get('/api/admin/nodes')
      .then((r) => setData(r.data))
      .catch((e) => setError(errMsg(e, 'No se pudieron cargar los nodos')));
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const guardar = async (ev) => {
    ev.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await api.post('/api/admin/nodes', {
        id: form.id,
        name: form.name,
        agent_url: form.agent_url,
        token: form.token || null,
        enabled: form.enabled ?? true,
      });
      // El backend solo devuelve el token generado una vez.
      if (!form.token) setToken({ nodo: form.id, valor: r.data.token });
      setForm(null);
      cargar();
    } catch (e) {
      setError(errMsg(e, 'No se pudo guardar el nodo'));
    } finally {
      setBusy(false);
    }
  };

  const reintentar = async (id) => {
    setError('');
    setReintentando(id);
    try {
      await api.post(`/api/admin/nodes/${id}/retry`);
      cargar();
    } catch (e) {
      setError(errMsg(e, 'No se pudo reintentar'));
    } finally {
      setReintentando(null);
    }
  };

  const eliminar = async (id) => {
    if (!window.confirm(`¿Eliminar el nodo ${id}? El orquestador dejará de enrutarle tráfico.`)) return;
    setError('');
    try {
      await api.delete(`/api/admin/nodes/${id}`);
      cargar();
    } catch (e) {
      setError(errMsg(e, 'No se pudo eliminar'));
    }
  };

  const vivo = Object.fromEntries((data?.live_status || []).map((n) => [n.id, n]));
  const nodos = data?.nodes || [];
  const enLinea = nodos.filter((n) => vivo[n.id]?.online).length;
  const aislados = nodos.filter((n) => vivo[n.id] && !vivo[n.id].online && vivo[n.id].circuit_breaker);

  return (
    <>
      <Cabecera
        titulo="Nodos"
        lead={data
          ? `${enLinea} de ${nodos.length} en línea${aislados.length ? ` · ${aislados.length} aislado(s) por el circuit breaker` : ''}.`
          : 'Consultando el orquestador…'}
      >
        <Boton onClick={cargar}><IconRefresh size={15} /> Refrescar</Boton>
        <Boton variante="primary" onClick={() => setForm({})}>
          <IconPlus size={15} /> Registrar nodo
        </Boton>
      </Cabecera>

      <div className="adm__body">
        <Aviso error>{error}</Aviso>

        {token && (
          <div className="adm-token">
            <div className="adm-token__txt">
              <span className="adm-token__aviso">
                Token de <strong>{token.nodo}</strong>. Configúralo como
                {' '}<span className="mono">NODE_SHARED_SECRET</span> en esa máquina:
                no se vuelve a mostrar.
              </span>
              <code>{token.valor}</code>
            </div>
            <button className="icon-btn" onClick={() => setToken(null)} aria-label="Cerrar">
              <IconX />
            </button>
          </div>
        )}

        {form && (
          <form className="adm-card" onSubmit={guardar}>
            <h2 className="adm-card__title">
              {form.editando ? `Editar ${form.id}` : 'Registrar un nodo'}
            </h2>
            <div className="adm-campos">
              <label className="adm-campo">
                <span className="adm-campo__label">Id del nodo</span>
                <input
                  className="adm-input adm-input--mono"
                  required
                  placeholder="gpu-02"
                  value={form.id || ''}
                  disabled={form.editando}
                  onChange={(e) => setForm({ ...form, id: e.target.value })}
                />
              </label>
              <label className="adm-campo">
                <span className="adm-campo__label">Nombre visible</span>
                <input
                  className="adm-input"
                  required
                  placeholder="PC del taller · RTX 4090"
                  value={form.name || ''}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <label className="adm-campo">
                <span className="adm-campo__label">URL del agente</span>
                <input
                  className="adm-input adm-input--mono"
                  required
                  placeholder="http://192.168.1.42:8100"
                  value={form.agent_url || ''}
                  onChange={(e) => setForm({ ...form, agent_url: e.target.value })}
                />
              </label>
              <label className="adm-campo">
                <span className="adm-campo__label">Token (vacío genera uno)</span>
                <input
                  className="adm-input adm-input--mono"
                  placeholder="se genera solo"
                  value={form.token || ''}
                  onChange={(e) => setForm({ ...form, token: e.target.value })}
                />
              </label>
            </div>
            <div className="adm-card__pie">
              <Boton onClick={() => setForm(null)}>Cancelar</Boton>
              <button className="adm-btn adm-btn--primary" type="submit" disabled={busy}>
                <IconCheck size={15} /> Guardar nodo
              </button>
            </div>
          </form>
        )}

        {!data ? <Cargando /> : nodos.length === 0 ? (
          <Tarjeta>
            <Vacio>
              No hay ningún nodo registrado. Sin nodos el clúster no puede servir
              inferencia: registra el primero con «Registrar nodo».
            </Vacio>
          </Tarjeta>
        ) : (
          <div className="adm-rejilla-4">
            {nodos.map((n) => (
              <TarjetaNodo
                key={n.id}
                nodo={n}
                st={vivo[n.id]}
                reintentando={reintentando === n.id}
                onReintentar={reintentar}
                onEditar={(x) => setForm({
                  editando: true, id: x.id, name: x.name, agent_url: x.agent_url,
                })}
                onEliminar={eliminar}
              />
            ))}
          </div>
        )}

        {aislados.map((n) => {
          const st = vivo[n.id];
          return (
            <Tarjeta key={n.id} titulo={`${n.id} · aislado por el circuit breaker`}>
              <Nota
                titulo={`${st.fallos} fallo(s) consecutivos al responder`}
                sub={st.retry_in_seconds > 0
                  ? `Próximo reintento en ${st.retry_in_seconds} s · se reintegra solo al responder.`
                  : 'Reintentando ahora · se reintegra solo al responder.'}
              />
              <div className="adm-card__pie">
                <Boton
                  disabled={reintentando === n.id}
                  onClick={() => reintentar(n.id)}
                >
                  <IconRefresh size={15} /> Reintentar ahora
                </Boton>
                <Boton peligro onClick={() => eliminar(n.id)}>Retirar del clúster</Boton>
              </div>
            </Tarjeta>
          );
        })}
      </div>
    </>
  );
}
