// McpList.jsx — Extensiones del agente: servidores MCP instalados (config del
// usuario y del proyecto) y un catálogo para añadir los más comunes.
import { useMemo, useState } from 'react';
import { useMcpStore } from '../../store/mcpStore';
import { useAppStore } from '../../store/appStore';
import { useFileViewStore } from '../../store/fileViewStore';
import { MCP_CATALOG } from '../../lib/mcp';
import { Segmented } from '../../components/Segmented';
import { SpinRing } from '../../components/Ring';
import { IconSearch, IconRefresh } from '../../components/Icons';

const initials = (name) => name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).replace(/^./, (c) => c.toUpperCase()) || 'MC';

export function StatusMark({ status }) {
  if (status === 'starting') return <SpinRing size={12} />;
  const tone = status === 'ready' ? 'dot--accent' : status === 'error' ? 'dot--danger' : '';
  return <span className={`dot ${tone}`} />;
}

export function McpList() {
  const { servers, errors, load } = useMcpStore();
  const root = useAppStore((s) => s.workspaceRoot);
  const activePath = useFileViewStore((s) => s.activePath);
  const openVirtual = useFileViewStore((s) => s.openVirtual);
  const [tab, setTab] = useState('installed');
  const [query, setQuery] = useState('');
  const [reloading, setReloading] = useState(false);

  const q = query.trim().toLowerCase();
  const installed = useMemo(
    () => Object.values(servers).filter((s) => !q || s.name.toLowerCase().includes(q)),
    [servers, q],
  );
  const catalog = MCP_CATALOG.filter((c) => !q || c.name.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q));

  const reload = async () => {
    setReloading(true);
    await load(root).finally(() => setReloading(false));
  };

  return (
    <div className="extlist">
      <div className="panelhead">
        <span className="panelhead__title">Extensiones</span>
        <div className="panelhead__fill" />
        <button className="ic" onClick={reload} title="Releer mcp.json">
          {reloading ? <SpinRing size={13} /> : <IconRefresh size={14} />}
        </button>
      </div>
      <div className="extlist__form">
        <div className="field field--strong">
          <IconSearch size={13} />
          <input value={query} placeholder="Buscar servidores MCP" onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Segmented
          value={tab}
          onChange={setTab}
          width={104}
          size="sm"
          options={[{ value: 'installed', label: `Instaladas${installed.length ? ` · ${installed.length}` : ''}` }, { value: 'catalog', label: 'Catálogo' }]}
        />
      </div>

      <div className="extlist__body scroll">
        {errors.map((e) => <p key={e} className="extlist__error">{e}</p>)}

        {tab === 'installed' && installed.length === 0 && (
          <p className="extlist__empty">
            Sin servidores MCP. Añade uno del catálogo o decláralo en <span className="mono">.lixbon/mcp.json</span>.
          </p>
        )}
        {tab === 'installed' && installed.map((s) => (
          <button
            key={s.name}
            className={`extrow rise ${activePath === `mcp://${s.name}` ? 'is-active' : ''}`}
            onClick={() => openVirtual(`mcp://${s.name}`, s.name)}
          >
            <span className="extrow__tile">{initials(s.name)}</span>
            <span className="extrow__main">
              <span className="extrow__name">{s.name}<StatusMark status={s.enabled ? s.status : 'stopped'} /></span>
              <span className="extrow__desc">
                {!s.enabled ? 'Desactivado' : s.status === 'ready' ? `${s.tools.length} herramientas` : s.status === 'error' ? s.error : s.status === 'starting' ? 'Iniciando…' : 'Detenido'}
              </span>
            </span>
            <span className="extrow__src">{s.source}</span>
          </button>
        ))}

        {tab === 'catalog' && catalog.map((c) => (
          <button
            key={c.id}
            className={`extrow rise ${activePath === `mcp-catalog://${c.id}` ? 'is-active' : ''}`}
            onClick={() => openVirtual(`mcp-catalog://${c.id}`, c.name)}
          >
            <span className="extrow__tile">{initials(c.name)}</span>
            <span className="extrow__main">
              <span className="extrow__name">{c.name}{servers[c.id] && <span className="tag tag--good">instalada</span>}</span>
              <span className="extrow__desc">{c.desc}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
