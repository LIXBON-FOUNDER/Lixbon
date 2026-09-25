// McpDetail.jsx — pestaña de un servidor MCP: estado, herramientas que aporta
// al agente y configuración; o, desde el catálogo, el formulario de alta.
import { useState } from 'react';
import { useMcpStore } from '../../store/mcpStore';
import { useAppStore } from '../../store/appStore';
import { useFileViewStore } from '../../store/fileViewStore';
import { MCP_CATALOG, saveMcpServer, removeMcpServer, templateFields, fillTemplate, toolName } from '../../lib/mcp';
import { Segmented } from '../../components/Segmented';
import { Switch } from '../../components/Switch';
import { SpinRing } from '../../components/Ring';
import { StatusMark } from './McpList';

const STATUS_LABEL = { ready: 'En marcha', starting: 'Iniciando…', stopped: 'Detenido', error: 'Con errores' };
const initials = (name) => name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).replace(/^./, (c) => c.toUpperCase()) || 'MC';
const mask = (v) => (v.length > 8 ? `${v.slice(0, 4)}••••${v.slice(-2)}` : '••••');

function Header({ name, subtitle, meta, children }) {
  return (
    <div className="mcpd__head rise">
      <span className="mcpd__tile">{initials(name)}</span>
      <div className="mcpd__id">
        <span className="mcpd__name">{name}</span>
        {subtitle && <span className="mcpd__sub">{subtitle}</span>}
        {meta && <span className="mono mcpd__meta">{meta}</span>}
      </div>
      <div className="mcpd__actions">{children}</div>
    </div>
  );
}

function InstalledDetail({ name }) {
  const entry = useMcpStore((s) => s.servers[name]);
  const { start, stop, setEnabled, load } = useMcpStore();
  const root = useAppStore((s) => s.workspaceRoot);
  const [busy, setBusy] = useState(false);

  if (!entry) return <div className="changes__empty">Este servidor ya no está en la configuración.</div>;

  const cmdline = [entry.spec.command, ...entry.spec.args].join(' ');
  const envKeys = Object.entries(entry.spec.env);
  const restart = async () => { setBusy(true); await start(name).finally(() => setBusy(false)); };
  const remove = async () => {
    await removeMcpServer(entry.source, root, name);
    await stop(name);
    await load(root);
    useFileViewStore.getState().close(`mcp://${name}`);
  };

  return (
    <div className="mcpd scroll">
      <Header name={name} subtitle={`Servidor MCP · configuración del ${entry.source}`} meta={cmdline}>
        <Switch checked={entry.enabled} onChange={(v) => setEnabled(name, v)} label="Activado" />
        {entry.enabled && (entry.status === 'ready' || entry.status === 'error'
          ? <button className="btn btn--ghost" onClick={restart} disabled={busy}>{busy && <SpinRing size={12} />}Reiniciar</button>
          : entry.status === 'stopped' && <button className="btn btn--primary" onClick={restart}>Iniciar</button>)}
      </Header>

      <div className="mcpd__status rise rise--1">
        <StatusMark status={entry.enabled ? entry.status : 'stopped'} />
        <span>{entry.enabled ? STATUS_LABEL[entry.status] : 'Desactivado'}</span>
        {entry.error && <span className="mcpd__error">{entry.error}</span>}
      </div>

      <div className="mcpd__grid rise rise--2">
        <section className="mcpd__section">
          <span className="fieldlabel">Herramientas para el agente</span>
          {entry.tools.length === 0 && <span className="mcpd__muted">{entry.status === 'ready' ? 'El servidor no declara herramientas.' : 'Se listan al iniciar el servidor.'}</span>}
          {entry.tools.map((t) => (
            <div key={t.name} className="mcpd__tool">
              <span className="mono mcpd__toolname">{toolName(name, t.name)}</span>
              {t.description && <span className="mcpd__tooldesc">{t.description}</span>}
            </div>
          ))}
        </section>
        <section className="mcpd__section">
          <span className="fieldlabel">Variables de entorno</span>
          {envKeys.length === 0 && <span className="mcpd__muted">Ninguna.</span>}
          {envKeys.map(([k, v]) => (
            <div key={k} className="mcpd__env mono"><span>{k}</span><span>{mask(v)}</span></div>
          ))}
          <span className="fieldlabel" style={{ marginTop: 18 }}>Permisos</span>
          <span className="mcpd__muted">Cada llamada del agente a estas herramientas pide tu aprobación, salvo que actives «Aplicar cambios sin preguntar».</span>
        </section>
      </div>

      <div className="mcpd__foot rise rise--3">
        <button className="lk is-danger" onClick={remove}>Quitar de la configuración</button>
      </div>
    </div>
  );
}

function CatalogDetail({ id }) {
  const entry = MCP_CATALOG.find((c) => c.id === id);
  const root = useAppStore((s) => s.workspaceRoot);
  const installed = useMcpStore((s) => s.servers[id]);
  const load = useMcpStore((s) => s.load);
  const [values, setValues] = useState({});
  const [scope, setScope] = useState(root ? 'proyecto' : 'usuario');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!entry) return null;
  const fields = templateFields(entry);
  const missing = fields.some((f) => !String(values[f.key] || '').trim());

  const install = async () => {
    setBusy(true);
    setError('');
    try {
      await saveMcpServer(scope, root, entry.id, fillTemplate(entry, values));
      await load(root);
      useFileViewStore.getState().close(`mcp-catalog://${id}`);
      useFileViewStore.getState().openVirtual(`mcp://${entry.id}`, entry.id);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mcpd scroll">
      <Header name={entry.name} subtitle={entry.desc} meta={[entry.command, ...entry.args].join(' ')}>
        <button className="btn btn--primary" onClick={install} disabled={busy || missing}>
          {busy && <SpinRing size={12} color="var(--on-primary)" />}
          {installed ? 'Reinstalar' : busy ? 'Instalando' : 'Instalar'}
        </button>
      </Header>

      <div className="mcpd__form rise rise--1">
        {fields.map((f) => (
          <label key={f.key} className="fieldlabel">
            {f.label}
            <div className="field field--strong">
              <input
                className="mono"
                type={f.secret ? 'password' : 'text'}
                value={values[f.key] || ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
            </div>
          </label>
        ))}
        <div className="fieldlabel">
          Dónde guardarlo
          <Segmented
            value={scope}
            onChange={setScope}
            width={150}
            options={[
              { value: 'proyecto', label: 'Este proyecto', title: '.lixbon/mcp.json' },
              { value: 'usuario', label: 'Todos mis proyectos', title: '~/.lixbon/mcp.json' },
            ]}
          />
        </div>
        <span className="mcpd__muted">
          Requiere {entry.command === 'uvx' ? 'uv (Python)' : 'Node.js'} instalado. La misma configuración la usa el CLI de lixbon.
        </span>
        {error && <span className="mcpd__error">{error}</span>}
      </div>
    </div>
  );
}

export function McpDetail({ path }) {
  if (path.startsWith('mcp://')) return <InstalledDetail name={path.slice(6)} />;
  return <CatalogDetail id={path.slice('mcp-catalog://'.length)} />;
}
