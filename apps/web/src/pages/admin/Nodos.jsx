import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useConfirmar } from '../../hooks/useConfirmar';
import {
  IconCheck, IconCopy, IconPlus, IconRefresh, IconTrash, IconX,
} from '../../components/Icons';
import {
  Aviso, Boton, Cabecera, Cargando, Chip, Medida, Nota, Tarjeta, Vacio,
  errMsg, fmtFecha, fmtHace,
} from './comunes';

// "Aislado" lo decidió el circuit breaker; "sin responder" es un nodo mudo.
// Un nodo por conexión no se pollea: o tiene el socket abierto o no.
function estadoDe(st) {
  if (!st) return { tono: 'off', texto: 'Sin datos' };
  if (st.online) return { tono: 'ok', texto: 'En línea' };
  if (st.mode === 'link') return { tono: 'warn', texto: 'Desconectado' };
  if (st.circuit_breaker) return { tono: 'bad', texto: 'Aislado' };
  return { tono: 'warn', texto: 'Sin responder' };
}

const pct = (v) => (typeof v === 'number' ? `${Math.round(v)}%` : '—');

function BotonCopiar({ texto }) {
  const [ok, setOk] = useState(false);
  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(texto);
      setOk(true);
      setTimeout(() => setOk(false), 1500);
    } catch { /* sin permiso de portapapeles: el texto sigue visible */ }
  };
  return (
    <Boton sm onClick={copiar}>
      {ok ? <><IconCheck size={13} /> Copiado</> : <><IconCopy size={13} /> Copiar</>}
    </Boton>
  );
}

function Comando({ titulo, texto }) {
  return (
    <div className="adm-token">
      <div className="adm-token__txt">
        <span className="adm-token__aviso">{titulo}</span>
        <code>{texto}</code>
      </div>
      <BotonCopiar texto={texto} />
    </div>
  );
}

function TarjetaNodo({ nodo, st, onReintentar, onEditar, onEliminar, reintentando }) {
  const e = estadoDe(st);
  const m = st?.metricas || {};
  // El agente reporta GPU libre; aquí se mira la ocupada.
  const vram = typeof m.gpu_free_percent === 'number' ? 100 - m.gpu_free_percent : null;
  const esLink = nodo.mode === 'link';

  return (
    <article className={`adm-nodo ${e.tono === 'bad' ? 'is-caido' : ''}`}>
      <div className="adm-nodo__top">
        <div className="adm-nodo__id">
          <div className="adm-nodo__nombre">
            <span className="adm-nodo__slug">{nodo.id}</span>
            <Chip tono={e.tono} punto>{e.texto}</Chip>
            <Chip>{esLink ? 'Conexión' : 'URL'}</Chip>
            {nodo.provider && <Chip mono>{nodo.provider}</Chip>}
          </div>
          <span className="adm-nodo__url">
            {esLink ? (st?.hostname || nodo.hostname || 'se conecta al gateway') : nodo.agent_url}
          </span>
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
        {st && !st.online && !esLink && (
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

function PanelEnrolar({ onCerrar, onCreado }) {
  const [label, setLabel] = useState('');
  const [ttl, setTtl] = useState(24);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resultado, setResultado] = useState(null);

  const crear = async (ev) => {
    ev.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await api.post('/api/admin/nodes/enrollments', { label: label || null, ttl_hours: Number(ttl) });
      setResultado(r.data);
      onCreado();
    } catch (e) {
      setError(errMsg(e, 'No se pudo generar el token'));
    } finally {
      setBusy(false);
    }
  };

  if (resultado) {
    const { commands, enrollment } = resultado;
    return (
      <div className="adm-card">
        <h2 className="adm-card__title">GPU lista para conectar</h2>
        <Aviso error>{error}</Aviso>
        <p className="adm-lista__label">
          Este token vale hasta {fmtFecha(enrollment.expires_at)} y se puede reutilizar en varias
          máquinas (una plantilla de pods). La máquina aparece aquí sola en cuanto arranca el agente.
          Solo se muestra completo ahora.
        </p>
        <Comando
          titulo="Linux con GPU (pod alquilado o servidor): pega esto en la terminal. Instala Ollama si falta y deja el agente como servicio."
          texto={commands.linux}
        />
        <Comando
          titulo="Windows con el repo clonado: PowerShell desde la raíz del repo. El token solo hace falta la primera vez."
          texto={commands.windows}
        />
        <Comando titulo="Linux/macOS con el repo clonado" texto={commands.manual} />
        <Comando
          titulo="Imagen Docker de Lixbon (infra/node): no es un comando, son las variables de entorno de la plantilla del pod"
          texto={commands.docker_env}
        />
        <div className="adm-card__pie">
          <Boton onClick={onCerrar}>Cerrar</Boton>
        </div>
      </div>
    );
  }

  return (
    <form className="adm-card" onSubmit={crear}>
      <h2 className="adm-card__title">Añadir GPU</h2>
      <p className="adm-lista__label">
        Genera un token de enrolamiento. La máquina lo canjea al arrancar, recibe su identidad
        y se conecta al gateway por WebSocket: sin túnel, sin DNS y sin puertos abiertos.
      </p>
      <Aviso error>{error}</Aviso>
      <div className="adm-campos">
        <label className="adm-campo">
          <span className="adm-campo__label">Etiqueta (opcional)</span>
          <input
            className="adm-input"
            placeholder="RunPod A100 · plantilla qwen"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label className="adm-campo">
          <span className="adm-campo__label">Validez (horas)</span>
          <input
            className="adm-input adm-input--mono"
            type="number"
            min="1"
            max="720"
            value={ttl}
            onChange={(e) => setTtl(e.target.value)}
          />
        </label>
      </div>
      <div className="adm-card__pie">
        <Boton onClick={onCerrar}>Cancelar</Boton>
        <button className="adm-btn adm-btn--primary" type="submit" disabled={busy}>
          <IconCheck size={15} /> Generar token
        </button>
      </div>
    </form>
  );
}

export default function Nodos() {
  const confirmar = useConfirmar();
  const [data, setData] = useState(null);
  const [enrollments, setEnrollments] = useState([]);
  const [form, setForm] = useState(null); // null = cerrado; {} = alta por URL
  const [enrolando, setEnrolando] = useState(false);
  const [token, setToken] = useState(null);
  const [reintentando, setReintentando] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const cargar = useCallback(() => {
    api.get('/api/admin/nodes')
      .then((r) => setData(r.data))
      .catch((e) => setError(errMsg(e, 'No se pudieron cargar los nodos')));
    api.get('/api/admin/nodes/enrollments')
      .then((r) => setEnrollments(r.data.enrollments.filter((x) => x.active)))
      .catch(() => {});
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // Los nodos por conexión aparecen solos: mientras hay un token vivo se refresca la lista.
  useEffect(() => {
    if (!enrollments.length) return undefined;
    const t = setInterval(cargar, 5000);
    return () => clearInterval(t);
  }, [enrollments.length, cargar]);

  const guardar = async (ev) => {
    ev.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await api.post('/api/admin/nodes', {
        id: form.id,
        name: form.name,
        agent_url: form.mode === 'link' ? null : form.agent_url,
        token: form.token || null,
        enabled: form.enabled ?? true,
        provider: form.provider || null,
      });
      // El backend solo devuelve el token generado una vez.
      if (r.data.token) setToken({ nodo: form.id, valor: r.data.token, mensaje: r.data.message });
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
    const ok = await confirmar({
      titulo: `¿Eliminar el nodo ${id}?`,
      texto: 'El orquestador dejará de enrutarle tráfico y, si está conectado, se le cierra la conexión.',
      etiqueta: 'Eliminar nodo',
    });
    if (!ok) return;
    setError('');
    try {
      await api.delete(`/api/admin/nodes/${id}`);
      cargar();
    } catch (e) {
      setError(errMsg(e, 'No se pudo eliminar'));
    }
  };

  const revocar = async (enr) => {
    const ok = await confirmar({
      titulo: `¿Revocar el token ${enr.label || enr.id}?`,
      texto: 'Las máquinas ya enroladas siguen funcionando; solo deja de servir para enrolar nuevas.',
      etiqueta: 'Revocar',
    });
    if (!ok) return;
    try {
      await api.delete(`/api/admin/nodes/enrollments/${enr.id}`);
      cargar();
    } catch (e) {
      setError(errMsg(e, 'No se pudo revocar'));
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
        <Boton onClick={() => { setEnrolando(false); setForm({ mode: 'url' }); }}>
          Registrar por URL
        </Boton>
        <Boton variante="primary" onClick={() => { setForm(null); setEnrolando(true); }}>
          <IconPlus size={15} /> Añadir GPU
        </Boton>
      </Cabecera>

      <div className="adm__body">
        <Aviso error>{error}</Aviso>

        {token && (
          <div className="adm-token">
            <div className="adm-token__txt">
              <span className="adm-token__aviso">
                Token de <strong>{token.nodo}</strong>. {token.mensaje}
              </span>
              <code>{token.valor}</code>
            </div>
            <BotonCopiar texto={token.valor} />
            <button className="icon-btn" onClick={() => setToken(null)} aria-label="Cerrar">
              <IconX />
            </button>
          </div>
        )}

        {enrolando && (
          <PanelEnrolar onCerrar={() => setEnrolando(false)} onCreado={cargar} />
        )}

        {form && (
          <form className="adm-card" onSubmit={guardar}>
            <h2 className="adm-card__title">
              {form.editando ? `Editar ${form.id}` : 'Registrar un nodo por URL'}
            </h2>
            {!form.editando && (
              <p className="adm-lista__label">
                Para una PC propia alcanzable por el gateway (LAN o túnel). Para GPUs alquiladas
                usa «Añadir GPU»: no necesita URL.
              </p>
            )}
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
              {form.mode !== 'link' && (
                <label className="adm-campo">
                  <span className="adm-campo__label">URL del agente</span>
                  <input
                    className="adm-input adm-input--mono"
                    required
                    placeholder="https://gpu-02.lixbon.com · http://192.168.1.42:8765"
                    value={form.agent_url || ''}
                    onChange={(e) => setForm({ ...form, agent_url: e.target.value })}
                  />
                </label>
              )}
              <label className="adm-campo">
                <span className="adm-campo__label">Proveedor (opcional)</span>
                <input
                  className="adm-input"
                  placeholder="propio · runpod · vast"
                  value={form.provider || ''}
                  onChange={(e) => setForm({ ...form, provider: e.target.value })}
                />
              </label>
              <label className="adm-campo">
                <span className="adm-campo__label">
                  {form.editando ? 'Token (vacío conserva el actual)' : 'Token (vacío genera uno)'}
                </span>
                <input
                  className="adm-input adm-input--mono"
                  placeholder={form.editando ? 'escribe uno para rotarlo' : 'se genera solo'}
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
              inferencia: pulsa «Añadir GPU» y pega el comando en la máquina.
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
                  mode: x.mode, provider: x.provider || '',
                })}
                onEliminar={eliminar}
              />
            ))}
          </div>
        )}

        {enrollments.length > 0 && (
          <Tarjeta titulo="Tokens de enrolamiento activos">
            {enrollments.map((enr) => (
              <div className="adm-lista__fila" key={enr.id}>
                <span className="adm-lista__label">
                  <span className="mono">{enr.token}</span>
                  {enr.label ? ` · ${enr.label}` : ''}
                  {` · ${enr.uses} uso(s) · caduca ${fmtFecha(enr.expires_at)}`}
                </span>
                <Boton sm peligro onClick={() => revocar(enr)}>Revocar</Boton>
              </div>
            ))}
          </Tarjeta>
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
