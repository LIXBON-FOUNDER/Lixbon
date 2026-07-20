// AdminPage.jsx — panel de administración (F6). Solo role=admin (el backend
// valida igualmente cada endpoint). Tabs: Resumen, Usuarios, Nodos, Modelos
// y Auditoría.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { api } from '../lib/api';
import { Logo } from '../components/Logo';
import { UsageChart } from '../components/UsageChart';
import { IconChevron, IconPlus, IconRefresh, IconTrash, IconX } from '../components/Icons';

const TABS = [
  { id: 'resumen', label: 'Resumen' },
  { id: 'usuarios', label: 'Usuarios' },
  { id: 'nodos', label: 'Nodos' },
  { id: 'modelos', label: 'Modelos' },
  { id: 'tarifas', label: 'Tarifas' },
  { id: 'ingresos', label: 'Ingresos' },
  { id: 'releases', label: 'Releases' },
  { id: 'auditoria', label: 'Auditoría' },
];

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const errMsg = (err, fallback) => {
  const d = err.response?.data?.detail;
  return (d && d.message) || (typeof d === 'string' ? d : fallback);
};

function StatTile({ label, value, hint }) {
  return (
    <div className="stat">
      <span className="stat__value">{value}</span>
      <span className="stat__label">{label}</span>
      {hint && <span className="stat__hint">{hint}</span>}
    </div>
  );
}

// ── Resumen ─────────────────────────────────────────────────────────────

function ResumenTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/admin/metrics')
      .then((res) => setData(res.data))
      .catch((err) => setError(errMsg(err, 'No se pudieron cargar las métricas')));
  }, []);

  if (error) return <p className="page__error" role="alert">{error}</p>;
  if (!data) return <p className="card__muted">Cargando…</p>;

  const t = data.totals;
  return (
    <>
      <div className="stats">
        <StatTile label="Usuarios" value={t.users} />
        <StatTile label="Activos (30 días)" value={t.active_users_period} />
        <StatTile label="Bloqueados" value={t.users_blocked} />
        <StatTile label="Conversaciones" value={t.conversations.toLocaleString()} />
        <StatTile label="Mensajes" value={t.messages.toLocaleString()} />
        <StatTile label="Nodos online" value={`${data.nodes.online} / ${data.nodes.total}`} />
      </div>

      <section className="card">
        <h2 className="card__title">Suscripciones por plan</h2>
        <div className="chips">
          {Object.entries(t.by_plan).length === 0 && <span className="card__muted">Sin suscripciones aún</span>}
          {Object.entries(t.by_plan).map(([plan, count]) => (
            <span key={plan} className="chip">{plan}: <strong>{count}</strong></span>
          ))}
        </div>
      </section>

      <section className="card">
        <h2 className="card__title">Tokens por día — todo el sistema (30 días)</h2>
        <UsageChart daily={data.daily} />
      </section>
    </>
  );
}

// ── Usuarios ────────────────────────────────────────────────────────────

function UserDetail({ userId }) {
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    api.get(`/api/admin/users/${userId}`).then((res) => setDetail(res.data)).catch(() => {});
  }, [userId]);

  if (!detail) return <p className="card__muted">Cargando detalle…</p>;
  const u = detail.usage;
  return (
    <div className="udetail">
      <p className="card__muted">
        Hoy: <strong>{u.messages_today}</strong> / {u.messages_per_day === -1 ? '∞' : u.messages_per_day} mensajes
        · Mes: <strong>{u.tokens_month.toLocaleString()}</strong> / {u.tokens_per_month === -1 ? '∞' : u.tokens_per_month.toLocaleString()} tokens
        · {detail.active_keys} API key(s) activa(s)
      </p>
      {detail.events.length > 0 && (
        <ul className="udetail__events">
          {detail.events.slice(0, 5).map((e) => (
            <li key={e.id}><code>{e.event_type}</code> — {fmtDate(e.created_at)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function UsuariosTab() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState([]);
  const [plans, setPlans] = useState([]);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback((query) => {
    api.get('/api/admin/users', { params: query ? { q: query } : {} })
      .then((res) => setUsers(res.data.users))
      .catch((err) => setError(errMsg(err, 'No se pudieron cargar los usuarios')));
  }, []);

  useEffect(() => {
    load('');
    api.get('/api/admin/plans').then((res) => setPlans(res.data.plans)).catch(() => {});
  }, [load]);

  const changePlan = async (userId, planId) => {
    setError('');
    try {
      await api.post(`/api/admin/users/${userId}/plan`, { plan_id: planId });
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, plan_id: planId } : u)));
    } catch (err) {
      setError(errMsg(err, 'No se pudo cambiar el plan'));
    }
  };

  const toggleActive = async (u) => {
    const verb = u.is_active ? 'bloquear' : 'desbloquear';
    if (!window.confirm(`¿Seguro que quieres ${verb} a ${u.email || u.username}?`)) return;
    setError('');
    try {
      await api.post(`/api/admin/users/${u.id}/active`, { active: !u.is_active });
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, is_active: !u.is_active } : x)));
    } catch (err) {
      setError(errMsg(err, `No se pudo ${verb}`));
    }
  };

  return (
    <>
      {error && <p className="page__error" role="alert">{error}</p>}
      <form
        className="admin-search"
        onSubmit={(e) => { e.preventDefault(); load(q); }}
      >
        <input
          className="admin-search__input"
          placeholder="Buscar por email o nombre…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="pill-btn pill-btn--primary" type="submit">Buscar</button>
      </form>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Usuario</th><th>Plan</th><th>Estado</th><th>Registro</th><th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <UserRow
                key={u.id}
                u={u}
                me={me}
                plans={plans}
                expanded={expanded === u.id}
                onExpand={() => setExpanded(expanded === u.id ? null : u.id)}
                onChangePlan={changePlan}
                onToggleActive={toggleActive}
              />
            ))}
            {users.length === 0 && (
              <tr><td colSpan={5} className="card__muted">Sin resultados</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function UserRow({ u, me, plans, expanded, onExpand, onChangePlan, onToggleActive }) {
  const isMe = me && me.id === u.id;
  return (
    <>
      <tr className={u.is_active ? '' : 'is-blocked'}>
        <td>
          <button className="table__expand" onClick={onExpand} aria-expanded={expanded}>
            <IconChevron size={13} open={expanded} />
            <span className="table__main">{u.email || u.username}</span>
          </button>
          <span className="table__sub">{[u.first_name, u.last_name].filter(Boolean).join(' ')}{u.role === 'admin' ? ' · admin' : ''}</span>
        </td>
        <td>
          <select
            className="table__select"
            value={u.plan_id}
            onChange={(e) => onChangePlan(u.id, e.target.value)}
            aria-label={`Plan de ${u.email || u.username}`}
          >
            {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </td>
        <td>
          <span className={`badge ${u.is_active ? 'badge--ok' : 'badge--bad'}`}>
            {u.is_active ? 'Activo' : 'Bloqueado'}
          </span>
        </td>
        <td className="table__muted">{u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}</td>
        <td>
          {!isMe && (
            <button
              className={`pill-btn pill-btn--outline table__action ${u.is_active ? 'is-danger' : ''}`}
              onClick={() => onToggleActive(u)}
            >
              {u.is_active ? 'Bloquear' : 'Desbloquear'}
            </button>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="table__detail-row">
          <td colSpan={5}><UserDetail userId={u.id} /></td>
        </tr>
      )}
    </>
  );
}

// ── Nodos ───────────────────────────────────────────────────────────────

function NodosTab() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null); // null = cerrado; {} = alta
  const [newToken, setNewToken] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(null); // id del nodo en reintento

  const load = useCallback(() => {
    api.get('/api/admin/nodes')
      .then((res) => setData(res.data))
      .catch((err) => setError(errMsg(err, 'No se pudieron cargar los nodos')));
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.post('/api/admin/nodes', {
        id: form.id, name: form.name, agent_url: form.agent_url,
        token: form.token || null, enabled: form.enabled ?? true,
      });
      if (!form.token) setNewToken({ node: form.id, token: res.data.token });
      setForm(null);
      load();
    } catch (err) {
      setError(errMsg(err, 'No se pudo guardar el nodo'));
    } finally {
      setBusy(false);
    }
  };

  const retry = async (id) => {
    setError('');
    setRetrying(id);
    try {
      await api.post(`/api/admin/nodes/${id}/retry`);
      load();
    } catch (err) {
      setError(errMsg(err, 'No se pudo reintentar'));
    } finally {
      setRetrying(null);
    }
  };

  const remove = async (id) => {
    if (!window.confirm(`¿Eliminar el nodo ${id}? El orquestador dejará de enrutarle tráfico.`)) return;
    try {
      await api.delete(`/api/admin/nodes/${id}`);
      load();
    } catch (err) {
      setError(errMsg(err, 'No se pudo eliminar'));
    }
  };

  if (error && !data) return <p className="page__error" role="alert">{error}</p>;
  if (!data) return <p className="card__muted">Cargando…</p>;

  const live = Object.fromEntries(data.live_status.map((n) => [n.id, n]));

  return (
    <>
      {error && <p className="page__error" role="alert">{error}</p>}
      <div className="card__row">
        <p className="card__muted">{data.nodes.length} nodo(s) registrado(s)</p>
        <div className="admin-actions">
          <button className="pill-btn pill-btn--outline card__small-cta" onClick={load}>Actualizar</button>
          <button className="pill-btn pill-btn--primary card__small-cta" onClick={() => setForm({})}>
            <IconPlus size={14} /> Nuevo nodo
          </button>
        </div>
      </div>

      {newToken && (
        <div className="key-reveal">
          <div>
            <strong>Token de {newToken.node} — configúralo como NODE_SHARED_SECRET en esa PC (no se volverá a mostrar):</strong>
            <code>{newToken.token}</code>
          </div>
          <button className="icon-btn" onClick={() => setNewToken(null)} aria-label="Cerrar"><IconX /></button>
        </div>
      )}

      {form && (
        <form className="card node-form" onSubmit={save}>
          <h2 className="card__title">{form.editing ? `Editar ${form.id}` : 'Nuevo nodo'}</h2>
          <div className="node-form__grid">
            <input required placeholder="id (ej: gpu-02)" value={form.id || ''} disabled={form.editing}
              onChange={(e) => setForm({ ...form, id: e.target.value })} />
            <input required placeholder="Nombre visible" value={form.name || ''}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input required placeholder="URL del agente (https://…)" value={form.agent_url || ''}
              onChange={(e) => setForm({ ...form, agent_url: e.target.value })} />
            <input placeholder="Token (vacío = generar uno nuevo)" value={form.token || ''}
              onChange={(e) => setForm({ ...form, token: e.target.value })} />
          </div>
          <div className="admin-actions">
            <button className="pill-btn pill-btn--outline" type="button" onClick={() => setForm(null)}>Cancelar</button>
            <button className="pill-btn pill-btn--primary" type="submit" disabled={busy}>Guardar</button>
          </div>
        </form>
      )}

      <div className="nodes">
        {data.nodes.map((n) => {
          const st = live[n.id];
          return (
            <article key={n.id} className="card node-card">
              <div className="card__row">
                <div>
                  <h2 className="card__title">{n.name} <span className="table__muted">({n.id})</span></h2>
                  <p className="card__muted">{n.agent_url}</p>
                </div>
                <span className={`badge ${st?.online ? 'badge--ok' : 'badge--bad'}`}>
                  {st?.online ? 'Online' : st?.circuit_breaker ? `Reintento en ${st.retry_in_seconds}s` : 'Offline'}
                </span>
              </div>
              {st && (
                <p className="card__muted node-card__meta">
                  score {st.score?.toFixed?.(2) ?? st.score} · {st.fallos} fallo(s)
                  {st.seconds_ago != null && ` · visto hace ${st.seconds_ago}s`}
                  {st.metricas?.cpu_percent != null && ` · CPU ${st.metricas.cpu_percent}%`}
                  {st.metricas?.ram_percent != null && ` · RAM ${st.metricas.ram_percent}%`}
                </p>
              )}
              {st?.modelos?.length > 0 && (
                <div className="chips">
                  {st.modelos.map((m) => <span key={m} className="chip">{m}</span>)}
                </div>
              )}
              <div className="admin-actions">
                {st && !st.online && (
                  <button className="pill-btn pill-btn--outline table__action"
                    onClick={() => retry(n.id)} disabled={retrying === n.id}>
                    <IconRefresh size={13} /> {retrying === n.id ? 'Reintentando…' : 'Reintentar'}
                  </button>
                )}
                <button className="pill-btn pill-btn--outline table__action"
                  onClick={() => setForm({ editing: true, id: n.id, name: n.name, agent_url: n.agent_url })}>
                  Editar
                </button>
                <button className="pill-btn pill-btn--outline table__action is-danger" onClick={() => remove(n.id)}>
                  <IconTrash size={13} /> Eliminar
                </button>
              </div>
            </article>
          );
        })}
        {data.nodes.length === 0 && <p className="card__muted">No hay nodos registrados.</p>}
      </div>
    </>
  );
}

// ── Modelos ─────────────────────────────────────────────────────────────

function ModelosTab() {
  const [data, setData] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [priceDrafts, setPriceDrafts] = useState({});
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [priceSaved, setPriceSaved] = useState('');

  useEffect(() => {
    api.get('/api/admin/models')
      .then((res) => {
        setData(res.data);
        setDrafts(Object.fromEntries(
          res.data.plans.map((p) => [p.id, (p.allowed_models || []).join(', ')]),
        ));
        setPriceDrafts(Object.fromEntries(
          res.data.plans.map((p) => [p.id, p.stripe_price_id || '']),
        ));
      })
      .catch((err) => setError(errMsg(err, 'No se pudieron cargar los modelos')));
  }, []);

  const savePlan = async (planId) => {
    setError('');
    setSaved('');
    const prefixes = drafts[planId].split(',').map((s) => s.trim()).filter(Boolean);
    try {
      await api.patch(`/api/admin/plans/${planId}`, { allowed_models: prefixes });
      setSaved(planId);
      setTimeout(() => setSaved(''), 2500);
    } catch (err) {
      setError(errMsg(err, 'No se pudo guardar'));
    }
  };

  const savePrice = async (planId) => {
    setError('');
    setPriceSaved('');
    try {
      await api.patch(`/api/admin/plans/${planId}`, { stripe_price_id: priceDrafts[planId].trim() || null });
      setPriceSaved(planId);
      setTimeout(() => setPriceSaved(''), 2500);
    } catch (err) {
      setError(errMsg(err, 'No se pudo guardar el precio'));
    }
  };

  if (error && !data) return <p className="page__error" role="alert">{error}</p>;
  if (!data) return <p className="card__muted">Cargando…</p>;

  return (
    <>
      {error && <p className="page__error" role="alert">{error}</p>}
      <section className="card">
        <h2 className="card__title">Modelos en el cluster</h2>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Modelo</th><th>Nodos</th><th>Planes que lo incluyen</th></tr></thead>
            <tbody>
              {data.models.map((m) => (
                <tr key={m.id}>
                  <td><code>{m.id}</code></td>
                  <td className="table__muted">{m.nodes.join(', ')}</td>
                  <td>
                    <div className="chips">
                      {m.plans.map((p) => <span key={p} className="chip">{p}</span>)}
                    </div>
                  </td>
                </tr>
              ))}
              {data.models.length === 0 && (
                <tr><td colSpan={3} className="card__muted">Sin nodos online — no hay modelos visibles ahora</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2 className="card__title">Modelos permitidos por plan</h2>
        <p className="card__muted">
          Prefijos separados por coma (ej: <code>llama3.2, gemma</code>). Vacío = todos los modelos.
        </p>
        {data.plans.map((p) => (
          <div key={p.id} className="plan-models">
            <span className="plan-models__name">{p.name}</span>
            <input
              className="plan-models__input"
              value={drafts[p.id] ?? ''}
              onChange={(e) => setDrafts({ ...drafts, [p.id]: e.target.value })}
              placeholder="Todos los modelos"
            />
            <button className="pill-btn pill-btn--primary table__action" onClick={() => savePlan(p.id)}>
              {saved === p.id ? 'Guardado ✓' : 'Guardar'}
            </button>
          </div>
        ))}
      </section>

      <section className="card">
        <h2 className="card__title">Precios de Stripe (pagos)</h2>
        <p className="card__muted">
          Pega el <code>price_...</code> de cada plan de pago (creado en Stripe → Productos).
          Conecta el plan con el checkout. Déjalo vacío en el plan gratuito.
        </p>
        {data.plans.filter((p) => p.price_monthly_cents > 0).map((p) => (
          <div key={p.id} className="plan-models">
            <span className="plan-models__name">{p.name}</span>
            <input
              className="plan-models__input"
              value={priceDrafts[p.id] ?? ''}
              onChange={(e) => setPriceDrafts({ ...priceDrafts, [p.id]: e.target.value })}
              placeholder="price_..."
            />
            <button className="pill-btn pill-btn--primary table__action" onClick={() => savePrice(p.id)}>
              {priceSaved === p.id ? 'Guardado ✓' : 'Guardar'}
            </button>
          </div>
        ))}
      </section>
    </>
  );
}

// ── Tarifas (créditos de API) ───────────────────────────────────────────

const EMPTY_PRICING = { model_prefix: '', display_name: '', input: '', output: '' };

function TarifasTab() {
  const [rows, setRows] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [nuevo, setNuevo] = useState(EMPTY_PRICING);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/api/admin/pricing');
      setRows(res.data.pricing);
      setDrafts(Object.fromEntries(res.data.pricing.map((r) => [r.id, {
        input: String(r.input_usd_per_mtok),
        output: String(r.output_usd_per_mtok),
      }])));
    } catch (err) {
      setError(errMsg(err, 'No se pudieron cargar las tarifas'));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async (row) => {
    setError('');
    const d = drafts[row.id];
    try {
      await api.patch(`/api/admin/pricing/${row.id}`, {
        input_usd_per_mtok: parseFloat(d.input) || 0,
        output_usd_per_mtok: parseFloat(d.output) || 0,
      });
      setSaved(row.id);
      setTimeout(() => setSaved(null), 2500);
      load();
    } catch (err) {
      setError(errMsg(err, 'No se pudo guardar la tarifa'));
    }
  };

  const toggleActive = async (row) => {
    setError('');
    try {
      await api.patch(`/api/admin/pricing/${row.id}`, { is_active: !row.is_active });
      load();
    } catch (err) {
      setError(errMsg(err, 'No se pudo cambiar el estado'));
    }
  };

  const remove = async (row) => {
    if (!window.confirm(`¿Eliminar la tarifa de "${row.model_prefix}"? Los modelos que la usaban pasarán a la tarifa por defecto (*).`)) return;
    setError('');
    try {
      await api.delete(`/api/admin/pricing/${row.id}`);
      load();
    } catch (err) {
      setError(errMsg(err, 'No se pudo eliminar'));
    }
  };

  const create = async () => {
    setError('');
    setBusy(true);
    try {
      await api.post('/api/admin/pricing', {
        model_prefix: nuevo.model_prefix.trim(),
        display_name: nuevo.display_name.trim() || null,
        input_usd_per_mtok: parseFloat(nuevo.input) || 0,
        output_usd_per_mtok: parseFloat(nuevo.output) || 0,
      });
      setNuevo(EMPTY_PRICING);
      load();
    } catch (err) {
      setError(errMsg(err, 'No se pudo crear la tarifa'));
    } finally {
      setBusy(false);
    }
  };

  if (error && !rows) return <p className="page__error" role="alert">{error}</p>;
  if (!rows) return <p className="card__muted">Cargando…</p>;

  return (
    <>
      {error && <p className="page__error" role="alert">{error}</p>}
      <section className="card">
        <h2 className="card__title">Tarifas por modelo (créditos de API)</h2>
        <p className="card__muted">
          Precio en <strong>USD por millón de tokens</strong>, match por prefijo del id del modelo
          (el más largo gana). La fila <code>*</code> es la tarifa por defecto y no se puede eliminar.
          Los cambios aplican a las peticiones nuevas en menos de un minuto.
        </p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Prefijo</th><th>Nombre</th><th>$ entrada / Mtok</th>
                <th>$ salida / Mtok</th><th>Estado</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><code>{r.model_prefix}</code></td>
                  <td className="table__muted">{r.display_name || '—'}</td>
                  <td>
                    <input
                      className="plan-models__input table-num"
                      value={drafts[r.id]?.input ?? ''}
                      onChange={(e) => setDrafts({ ...drafts, [r.id]: { ...drafts[r.id], input: e.target.value } })}
                    />
                  </td>
                  <td>
                    <input
                      className="plan-models__input table-num"
                      value={drafts[r.id]?.output ?? ''}
                      onChange={(e) => setDrafts({ ...drafts, [r.id]: { ...drafts[r.id], output: e.target.value } })}
                    />
                  </td>
                  <td>
                    <button className="pill-btn pill-btn--outline table__action" onClick={() => toggleActive(r)}>
                      {r.is_active ? 'Activa' : 'Inactiva'}
                    </button>
                  </td>
                  <td>
                    <button className="pill-btn pill-btn--primary table__action" onClick={() => save(r)}>
                      {saved === r.id ? 'Guardado ✓' : 'Guardar'}
                    </button>
                    {r.model_prefix !== '*' && (
                      <button className="pill-btn pill-btn--outline table__action is-danger" onClick={() => remove(r)}>
                        <IconTrash size={13} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2 className="card__title">Nueva tarifa</h2>
        <div className="plan-models">
          <input
            className="plan-models__input"
            placeholder="Prefijo (ej: qwen2.5)"
            value={nuevo.model_prefix}
            onChange={(e) => setNuevo({ ...nuevo, model_prefix: e.target.value })}
          />
          <input
            className="plan-models__input"
            placeholder="Nombre visible (opcional)"
            value={nuevo.display_name}
            onChange={(e) => setNuevo({ ...nuevo, display_name: e.target.value })}
          />
          <input
            className="plan-models__input table-num"
            placeholder="$ entrada"
            value={nuevo.input}
            onChange={(e) => setNuevo({ ...nuevo, input: e.target.value })}
          />
          <input
            className="plan-models__input table-num"
            placeholder="$ salida"
            value={nuevo.output}
            onChange={(e) => setNuevo({ ...nuevo, output: e.target.value })}
          />
          <button
            className="pill-btn pill-btn--primary table__action"
            disabled={busy || !nuevo.model_prefix.trim()}
            onClick={create}
          >
            <IconPlus size={13} /> Añadir
          </button>
        </div>
      </section>
    </>
  );
}

// ── Ingresos (créditos de API) ──────────────────────────────────────────

function GrantCreditsCard() {
  const [email, setEmail] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');

  const grant = async () => {
    const parsed = parseFloat(amount);
    if (!email.trim() || !Number.isFinite(parsed) || parsed === 0) {
      setError('Indica un correo y un monto distinto de 0.');
      return;
    }
    setBusy(true);
    setError('');
    setResult('');
    try {
      const res = await api.post('/api/admin/credits/grant', {
        email: email.trim(),
        amount_usd: parsed,
        note: note.trim() || null,
      });
      setResult(`Acreditado $${res.data.granted_usd.toFixed(2)} — saldo nuevo: $${res.data.balance_usd.toFixed(4)}`);
      setAmount('');
      setNote('');
    } catch (err) {
      setError(errMsg(err, 'No se pudo acreditar el saldo'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2 className="card__title">Acreditar saldo de API</h2>
      <p className="card__muted">
        Añade créditos a un usuario sin pasar por Stripe (pruebas, promociones, soporte).
        Queda en el ledger como <code>grant</code>; un monto negativo corrige un abono erróneo.
      </p>
      <div className="plan-models">
        <input
          className="plan-models__input"
          type="email"
          placeholder="correo del usuario"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="plan-models__input table-num"
          placeholder="monto USD (ej: 5)"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <input
          className="plan-models__input"
          placeholder="nota (opcional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button
          className="pill-btn pill-btn--primary table__action"
          disabled={busy || !email.trim() || !amount.trim()}
          onClick={grant}
        >
          {busy ? 'Acreditando…' : 'Acreditar'}
        </button>
      </div>
      {result && <p className="card__muted" role="status">{result}</p>}
      {error && <p className="page__error" role="alert">{error}</p>}
    </section>
  );
}

function IngresosTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/admin/credits/summary')
      .then((res) => setData(res.data))
      .catch((err) => setError(errMsg(err, 'No se pudo cargar el resumen de ingresos')));
  }, []);

  if (error) return <p className="page__error" role="alert">{error}</p>;
  if (!data) return <p className="card__muted">Cargando…</p>;

  const consumo = data.usage_by_model.reduce((a, r) => a + r.cost_usd, 0);

  return (
    <>
      <div className="stats">
        <StatTile label={`Ingresos ${data.month}`} value={`$${data.total_revenue_usd.toFixed(2)}`} />
        <StatTile
          label="Suscripciones (MRR)"
          value={`$${data.subscription_mrr_usd.toFixed(2)}`}
          hint={`${data.active_subscriptions} de pago activas`}
        />
        <StatTile
          label="Recargas de créditos"
          value={`$${data.topups_usd.toFixed(2)}`}
          hint={`${data.purchases} este mes`}
        />
      </div>
      <p className="card__muted admin-hint">
        <strong>Ingresos</strong> = suscripciones (ingreso recurrente de los planes de pago) +
        recargas de créditos del mes. El consumo de créditos de más abajo <strong>no</strong> es
        ingreso: es saldo prepago que el usuario ya pagó y ahora gasta.
      </p>

      <GrantCreditsCard />

      <section className="card">
        <h2 className="card__title">Consumo de créditos por modelo — {data.month}</h2>
        <p className="card__muted">
          Saldo prepago gastado por uso de API (débitos del ledger), <strong>no</strong> ingreso.
          El costo se congela al momento del cobro: editar Tarifas después no recalcula lo ya cobrado.
        </p>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Modelo</th><th>Tokens</th><th>Peticiones</th><th>Consumido</th></tr></thead>
            <tbody>
              {data.usage_by_model.map((r, i) => (
                <tr key={i}>
                  <td><code>{r.model}</code></td>
                  <td>{r.tokens.toLocaleString()}</td>
                  <td>{r.requests}</td>
                  <td>${r.cost_usd.toFixed(4)}</td>
                </tr>
              ))}
              {data.usage_by_model.length === 0 ? (
                <tr><td colSpan={4} className="card__muted">Sin consumo de créditos este mes</td></tr>
              ) : (
                <tr className="table__total-row">
                  <td colSpan={3}><strong>Total consumido</strong></td>
                  <td><strong>${consumo.toFixed(4)}</strong></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2 className="card__title">Top consumidores de créditos — {data.month}</h2>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Usuario</th><th>Tokens</th><th>Consumido</th></tr></thead>
            <tbody>
              {data.top_consumers.map((r, i) => (
                <tr key={i}>
                  <td>{r.email}</td>
                  <td>{r.tokens.toLocaleString()}</td>
                  <td>${r.cost_usd.toFixed(4)}</td>
                </tr>
              ))}
              {data.top_consumers.length === 0 && (
                <tr><td colSpan={3} className="card__muted">Sin consumo de créditos este mes</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

// ── Releases ────────────────────────────────────────────────────────────

const EMPTY_RELEASE = { product: 'desktop', version: '', channel: 'stable', title: '', changelog: '', checksum_sha256: '' };

function ReleasesTab() {
  const [versions, setVersions] = useState([]);
  const [form, setForm] = useState(EMPTY_RELEASE);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  const load = useCallback(() => {
    api.get('/api/versions')
      .then((res) => setVersions(res.data))
      .catch((err) => setError(errMsg(err, 'No se pudieron cargar las versiones')));
  }, []);

  useEffect(() => { load(); }, [load]);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setOk('');
    if (!file) { setError('Selecciona el archivo del instalador'); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('product', form.product);
      fd.append('version', form.version.trim());
      fd.append('channel', form.channel);
      fd.append('title', form.title.trim());
      // el changelog viaja como JSON (una línea por viñeta)
      const items = form.changelog.split('\n').map((s) => s.trim()).filter(Boolean);
      fd.append('changelog', JSON.stringify(items.length ? items : [form.title.trim()]));
      if (form.checksum_sha256.trim()) fd.append('checksum_sha256', form.checksum_sha256.trim());
      fd.append('file', file);

      const res = await api.post('/api/versions/upload', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setOk(`Versión ${res.data.version} publicada (${res.data.storage}).`);
      setForm(EMPTY_RELEASE);
      setFile(null);
      load();
    } catch (err) {
      setError(errMsg(err, 'No se pudo publicar la versión'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error && <p className="page__error" role="alert">{error}</p>}
      {ok && <p className="admin-ok" role="status">{ok}</p>}

      <form className="card release-form" onSubmit={submit}>
        <h2 className="card__title">Publicar una versión</h2>
        <p className="card__muted">
          Sube el instalador (Desktop <code>.msi</code> o el paquete del CLI). Se guarda
          en el almacenamiento privado y la descarga se sirve por URL firmada.
        </p>
        <div className="release-form__grid">
          <label>Producto
            <select value={form.product} onChange={(e) => setForm({ ...form, product: e.target.value })}>
              <option value="desktop">desktop (MSI)</option>
              <option value="android">android (APK)</option>
            </select>
          </label>
          <label>Versión
            <input required placeholder="2.5.0" value={form.version}
              onChange={(e) => setForm({ ...form, version: e.target.value })} />
          </label>
          <label>Canal
            <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
              <option value="stable">stable</option>
              <option value="beta">beta</option>
            </select>
          </label>
          <label>Título
            <input required placeholder="Mejoras de rendimiento" value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </label>
          <label>Checksum SHA-256 (opcional)
            <input placeholder="para firmar la actualización" value={form.checksum_sha256}
              onChange={(e) => setForm({ ...form, checksum_sha256: e.target.value })} />
          </label>
        </div>
        <label className="release-form__full">Changelog (una línea por punto)
          <textarea rows={3} placeholder={"Corrige el streaming\nNuevo selector de modelos"}
            value={form.changelog} onChange={(e) => setForm({ ...form, changelog: e.target.value })} />
        </label>
        <label className="release-form__full">Instalador
          <input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </label>
        <div className="admin-actions">
          <button className="pill-btn pill-btn--primary" type="submit" disabled={busy}>
            {busy ? 'Publicando…' : 'Publicar versión'}
          </button>
        </div>
      </form>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr><th>Producto</th><th>Versión</th><th>Canal</th><th>Título</th><th>Fecha</th></tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={`${v.product || 'desktop'}-${v.version}-${v.channel}`}>
                <td><span className="chip">{v.product || 'desktop'}</span></td>
                <td><code>{v.version}</code></td>
                <td><span className={`badge ${v.channel === 'stable' ? 'badge--ok' : 'chip'}`}>{v.channel}</span></td>
                <td>{v.title}</td>
                <td className="table__muted">{v.release_date}</td>
              </tr>
            ))}
            {versions.length === 0 && (
              <tr><td colSpan={5} className="card__muted">Aún no hay versiones publicadas</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── Auditoría ───────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

function AuditoriaTab() {
  const [events, setEvents] = useState([]);
  const [type, setType] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback((offset, eventType, replace) => {
    api.get('/api/admin/audit', {
      params: { limit: PAGE_SIZE, offset, ...(eventType ? { event_type: eventType } : {}) },
    })
      .then((res) => {
        setEvents((prev) => (replace ? res.data.events : [...prev, ...res.data.events]));
        setDone(res.data.events.length < PAGE_SIZE);
      })
      .catch((err) => setError(errMsg(err, 'No se pudo cargar la auditoría')));
  }, []);

  useEffect(() => { load(0, '', true); }, [load]);

  return (
    <>
      {error && <p className="page__error" role="alert">{error}</p>}
      <form
        className="admin-search"
        onSubmit={(e) => { e.preventDefault(); load(0, type, true); }}
      >
        <input
          className="admin-search__input"
          placeholder="Filtrar por tipo de evento (ej: user_login)…"
          value={type}
          onChange={(e) => setType(e.target.value)}
        />
        <button className="pill-btn pill-btn--primary" type="submit">Filtrar</button>
      </form>

      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Fecha</th><th>Evento</th><th>Usuario</th><th>IP</th><th>Detalle</th></tr></thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td className="table__muted">{fmtDate(e.created_at)}</td>
                <td><code>{e.event_type}</code></td>
                <td className="table__muted">{e.user_id ?? '—'}</td>
                <td className="table__muted">{e.ip_address || '—'}</td>
                <td className="table__muted table__meta">
                  {Object.keys(e.metadata || {}).length ? JSON.stringify(e.metadata) : '—'}
                </td>
              </tr>
            ))}
            {events.length === 0 && <tr><td colSpan={5} className="card__muted">Sin eventos</td></tr>}
          </tbody>
        </table>
      </div>
      {!done && events.length > 0 && (
        <button className="pill-btn pill-btn--outline admin-more" onClick={() => load(events.length, type, false)}>
          Cargar más
        </button>
      )}
    </>
  );
}

// ── Página ──────────────────────────────────────────────────────────────

export default function AdminPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState('resumen');
  const tabsRef = useRef({});
  const [indicator, setIndicator] = useState({ left: 0, width: 0, ready: false });

  useEffect(() => {
    if (loading) return;
    if (!user) navigate('/auth', { replace: true });
    else if (user.role !== 'admin') navigate('/', { replace: true });
  }, [user, loading, navigate]);

  // Posiciona el indicador deslizante bajo la tab activa (anima left/width).
  useEffect(() => {
    const el = tabsRef.current[tab];
    if (el) setIndicator({ left: el.offsetLeft, width: el.offsetWidth, ready: true });
  }, [tab, loading, user]);

  if (loading || !user || user.role !== 'admin') {
    return (
      <div className="app-loading">
        <span className="brand app-loading__logo">LIXBON</span>
        <span className="app-loading__bar"><span /></span>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page__bar">
        <Link to="/" className="page__logo"><Logo size={30} /></Link>
        <Link to="/" className="pill-btn pill-btn--outline page__back">Volver al chat</Link>
      </header>

      <main className="page__body page__body--wide">
        <h1 className="page__title">Panel de administración</h1>

        <nav className="admin-tabs" role="tablist">
          <span
            className="admin-tabs__indicator"
            style={{ left: indicator.left, width: indicator.width, opacity: indicator.ready ? 1 : 0 }}
          />
          {TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => { tabsRef.current[t.id] = el; }}
              role="tab"
              aria-selected={tab === t.id}
              className={`admin-tab ${tab === t.id ? 'is-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {tab === 'resumen' && <ResumenTab />}
        {tab === 'usuarios' && <UsuariosTab />}
        {tab === 'nodos' && <NodosTab />}
        {tab === 'modelos' && <ModelosTab />}
        {tab === 'tarifas' && <TarifasTab />}
        {tab === 'ingresos' && <IngresosTab />}
        {tab === 'releases' && <ReleasesTab />}
        {tab === 'auditoria' && <AuditoriaTab />}
      </main>
    </div>
  );
}
