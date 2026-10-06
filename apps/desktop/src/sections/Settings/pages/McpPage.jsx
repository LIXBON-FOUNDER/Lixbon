// McpPage.jsx — Ajustes → Servidores MCP: ver, añadir, editar, importar y
// quitar los servidores que usa el agente de Lixbon sin tocar mcp.json a mano.
import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useMcpStore } from '../../../store/mcpStore';
import { useAppStore } from '../../../store/appStore';
import { useFileViewStore } from '../../../store/fileViewStore';
import {
  MCP_CATALOG, saveMcpServer, removeMcpServer, splitCommandLine, joinCommandLine,
  remoteSpec, remoteUrlOf, parseMcpJson, specFrom, slug,
} from '../../../lib/mcp';
import { Switch } from '../../../components/Switch';
import { Segmented } from '../../../components/Segmented';
import { SpinRing } from '../../../components/Ring';
import { StatusMark } from '../../Extensions/McpList';
import { PageHead } from '../SettingsParts';
import { IconPlus, IconRefresh, IconTrash, IconPencil, IconEye, IconEyeOff, IconX, IconDownload, IconExternal, IconPuzzle } from '../../../components/Icons';

const SCOPE_LABEL = { usuario: 'Global', proyecto: 'Proyecto' };
const initials = (name) => name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).replace(/^./, (c) => c.toUpperCase()) || 'MC';
const emptyRows = () => [{ key: '', value: '' }];
const toRows = (obj) => { const r = Object.entries(obj || {}).map(([key, value]) => ({ key, value })); return r.length ? r : emptyRows(); };
const fromRows = (rows) => Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));

function headersOf(spec) {
  const out = {};
  const a = spec.args || [];
  for (let i = 3; i < a.length - 1; i++) {
    if (a[i] === '--header') { const [k, ...v] = a[i + 1].split(':'); out[k] = v.join(':'); i++; }
  }
  return out;
}

function KeyValues({ rows, onChange, keyHint, valueHint }) {
  const [show, setShow] = useState(false);
  const set = (i, patch) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <div className="mcpf__kv">
      {rows.map((r, i) => (
        <div key={i} className="mcpf__kvrow">
          <div className="field field--strong mcpf__key"><input value={r.key} placeholder={keyHint} spellCheck={false} onChange={(e) => set(i, { key: e.target.value })} /></div>
          <div className="field field--strong">
            <input type={show ? 'text' : 'password'} value={r.value} placeholder={valueHint} spellCheck={false} onChange={(e) => set(i, { value: e.target.value })} />
            <button type="button" className="ic" title={show ? 'Ocultar' : 'Mostrar'} onClick={() => setShow((v) => !v)}>{show ? <IconEyeOff size={13} /> : <IconEye size={13} />}</button>
          </div>
          <button type="button" className="ic" title="Quitar" onClick={() => onChange(rows.length > 1 ? rows.filter((_, k) => k !== i) : emptyRows())}><IconX size={12} /></button>
        </div>
      ))}
      <button type="button" className="lk mcpf__add" onClick={() => onChange([...rows, { key: '', value: '' }])}>+ Añadir</button>
    </div>
  );
}

/** Alta o edición. `editing` = entrada del store cuando se edita una existente. */
function ServerForm({ editing, root, onDone }) {
  const load = useMcpStore((s) => s.load);
  const remote = editing ? remoteUrlOf(editing.spec) : null;
  const [kind, setKind] = useState(remote ? 'url' : 'command');
  const [name, setName] = useState(editing?.name || '');
  const [scope, setScope] = useState(editing?.source || 'usuario');
  const [line, setLine] = useState(editing && !remote ? joinCommandLine(editing.spec) : '');
  const [env, setEnv] = useState(toRows(editing && !remote ? editing.spec.env : null));
  const [url, setUrl] = useState(remote || '');
  const [headers, setHeaders] = useState(toRows(editing && remote ? headersOf(editing.spec) : null));
  const [json, setJson] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const fromTemplate = (c) => {
    setKind('command');
    setName((n) => n || c.id);
    setLine(joinCommandLine({ command: c.command, args: c.args.map((a) => (/^\{.+\}$/.test(a) ? '' : a)) }));
    setEnv(toRows(Object.fromEntries(Object.entries(c.env).map(([k]) => [k, '']))));
    setError(c.args.some((a) => /^\{.+\}$/.test(a)) ? `Completa en el comando: ${c.args.filter((a) => /^\{.+\}$/.test(a)).map((a) => a.slice(1, -1)).join(', ')}` : '');
  };

  const build = () => {
    const clean = slug(name.trim()).replace(/_/g, '-');
    if (kind === 'json') return parseMcpJson(json, clean);
    if (!clean) throw new Error('Ponle un nombre al servidor.');
    if (kind === 'url') {
      if (!/^https?:\/\//i.test(url.trim())) throw new Error('La URL debe empezar por https:// o http://');
      return { [clean]: remoteSpec(url.trim(), fromRows(headers)) };
    }
    const parts = splitCommandLine(line);
    if (!parts.length) throw new Error('Escribe el comando que arranca el servidor, por ejemplo: npx -y @modelcontextprotocol/server-github');
    return { [clean]: { command: parts[0], args: parts.slice(1), env: fromRows(env) } };
  };

  const save = async () => {
    setError('');
    let servers;
    try { servers = build(); } catch (e) { setError(e.message); return; }
    setBusy(true);
    try {
      if (editing && (editing.source !== scope || !servers[editing.name])) await removeMcpServer(editing.source, root, editing.name);
      for (const [n, spec] of Object.entries(servers)) await saveMcpServer(scope, root, n, spec);
      await load(root);
      onDone(Object.keys(servers));
    } catch (e) {
      setError(String(e?.message || e));
    }
    setBusy(false);
  };

  return (
    <div className="ssec ssec--card mcpf rise">
      <div className="mcpf__head">
        <span className="srow__label">{editing ? `Editar ${editing.name}` : 'Nuevo servidor MCP'}</span>
        <div className="panelhead__fill" />
        <Segmented
          size="sm"
          width={92}
          value={kind}
          onChange={setKind}
          options={[{ value: 'command', label: 'Comando' }, { value: 'url', label: 'URL remota' }, ...(editing ? [] : [{ value: 'json', label: 'Pegar JSON' }])]}
        />
      </div>

      {!editing && kind === 'command' && (
        <div className="mcpf__templates">
          <span className="srow__hint">Plantillas:</span>
          {MCP_CATALOG.map((c) => <button key={c.id} type="button" className="cccmd__choice" title={c.desc} onClick={() => fromTemplate(c)}>{c.name}</button>)}
        </div>
      )}

      <div className="mcpf__grid">
        <label className="fieldlabel">
          Nombre{kind === 'json' && <span className="srow__hint"> (solo si pegas un único servidor)</span>}
          <div className="field field--strong"><input value={name} placeholder="github" spellCheck={false} onChange={(e) => setName(e.target.value)} /></div>
        </label>
        <label className="fieldlabel">
          Dónde se guarda
          <Segmented
            size="sm"
            width={118}
            value={scope}
            onChange={setScope}
            options={[{ value: 'usuario', label: 'Todos los proyectos' }, ...(root ? [{ value: 'proyecto', label: 'Solo este proyecto' }] : [])]}
          />
        </label>
      </div>

      {kind === 'command' && (
        <>
          <label className="fieldlabel">
            Comando
            <div className="field field--strong"><input className="mono" value={line} placeholder="npx -y @modelcontextprotocol/server-github" spellCheck={false} onChange={(e) => setLine(e.target.value)} /></div>
          </label>
          <span className="fieldlabel">Variables de entorno <span className="srow__hint">tokens y claves; se guardan en el mcp.json de tu equipo</span></span>
          <KeyValues rows={env} onChange={setEnv} keyHint="GITHUB_PERSONAL_ACCESS_TOKEN" valueHint="valor" />
        </>
      )}

      {kind === 'url' && (
        <>
          <label className="fieldlabel">
            URL del servidor
            <div className="field field--strong"><input className="mono" value={url} placeholder="https://mcp.ejemplo.com/mcp" spellCheck={false} onChange={(e) => setUrl(e.target.value)} /></div>
          </label>
          <span className="srow__hint">Se conecta con <span className="mono">mcp-remote</span> (necesita Node). Si el servidor pide iniciar sesión, se abrirá el navegador la primera vez.</span>
          <span className="fieldlabel">Cabeceras <span className="srow__hint">opcional, por ejemplo Authorization = Bearer …</span></span>
          <KeyValues rows={headers} onChange={setHeaders} keyHint="Authorization" valueHint="Bearer …" />
        </>
      )}

      {kind === 'json' && (
        <label className="fieldlabel">
          Configuración
          <textarea
            className="mcpf__json mono"
            value={json}
            spellCheck={false}
            placeholder={'{\n  "mcpServers": {\n    "github": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-github"]\n    }\n  }\n}'}
            onChange={(e) => setJson(e.target.value)}
          />
          <span className="srow__hint">El bloque que traen las documentaciones para Claude, Cursor o VS Code. Puede tener varios servidores.</span>
        </label>
      )}

      {error && <p className="mcpf__error">{error}</p>}
      <div className="mcpf__actions">
        <button type="button" className="btn btn--ghost" onClick={() => onDone(null)}>Cancelar</button>
        <button type="button" className="btn btn--primary" disabled={busy} onClick={save}>{busy && <SpinRing size={12} />}{editing ? 'Guardar y reiniciar' : 'Añadir y arrancar'}</button>
      </div>
    </div>
  );
}

function ImportPanel({ root, installed, onDone }) {
  const load = useMcpStore((s) => s.load);
  const [sources, setSources] = useState(null);
  const [picked, setPicked] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    invoke('mcp_import_sources', { cwd: root || '' }).then((list) => {
      const flat = [];
      for (const src of list) {
        for (const [name, raw] of Object.entries(src.servers || {})) {
          const spec = specFrom(raw);
          flat.push({ id: `${src.source}:${name}`, name, source: src.source, spec, remote: !raw?.command && !!raw?.url });
        }
      }
      setSources(flat);
      setPicked(Object.fromEntries(flat.filter((s) => s.spec && !installed[s.name]).map((s) => [s.id, true])));
    }).catch(() => setSources([]));
  }, [root]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    setBusy(true);
    const chosen = sources.filter((s) => picked[s.id] && s.spec);
    for (const s of chosen) await saveMcpServer('usuario', root, s.name, s.spec);
    await load(root);
    setBusy(false);
    onDone(chosen.map((s) => s.name));
  };

  return (
    <div className="ssec ssec--card mcpf rise">
      <div className="mcpf__head">
        <span className="srow__label">Importar de otros agentes</span>
        <div className="panelhead__fill" />
        <button type="button" className="ic" title="Cerrar" onClick={() => onDone(null)}><IconX size={13} /></button>
      </div>
      <span className="srow__hint">Claude Code, Claude Desktop, Cursor y VS Code. Se copian a tu configuración global de Lixbon; los originales no se tocan.</span>
      {sources === null && <span className="srow__hint"><SpinRing size={12} /> Buscando…</span>}
      {sources?.length === 0 && <span className="srow__hint">No se encontró ningún servidor MCP en otros agentes.</span>}
      {sources?.map((s) => (
        <label key={s.id} className="mcpf__pick">
          <input type="checkbox" checked={!!picked[s.id]} disabled={!s.spec} onChange={(e) => setPicked({ ...picked, [s.id]: e.target.checked })} />
          <span className="mcprow__tile">{initials(s.name)}</span>
          <span className="mcprow__main">
            <span className="srow__label">{s.name}{installed[s.name] && <span className="orch__pill">ya instalado</span>}</span>
            <span className="mono srow__tools">{s.source} · {s.remote ? `remoto: ${remoteUrlOf(s.spec)}` : s.spec ? joinCommandLine(s.spec) : 'formato no compatible'}</span>
          </span>
        </label>
      ))}
      {sources?.length > 0 && (
        <div className="mcpf__actions">
          <button type="button" className="btn btn--ghost" onClick={() => onDone(null)}>Cancelar</button>
          <button type="button" className="btn btn--primary" disabled={busy || !Object.values(picked).some(Boolean)} onClick={run}>
            {busy && <SpinRing size={12} />}Importar {Object.values(picked).filter(Boolean).length}
          </button>
        </div>
      )}
    </div>
  );
}

function ServerRow({ s, root, onEdit }) {
  const { start, stop, setEnabled, load } = useMcpStore();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const url = remoteUrlOf(s.spec);
  const detail = !s.enabled ? 'Desactivado'
    : s.status === 'ready' ? `${s.tools.length} herramienta${s.tools.length === 1 ? '' : 's'}`
      : s.status === 'starting' ? 'Arrancando…'
        : s.status === 'error' ? s.error : 'Detenido';

  const remove = async () => {
    await removeMcpServer(s.source, root, s.name);
    await stop(s.name);
    await load(root);
    useFileViewStore.getState().close(`mcp://${s.name}`);
  };

  return (
    <div className={`srow mcprow ${s.status === 'error' && s.enabled ? 'is-error' : ''}`}>
      <span className="mcprow__tile">{initials(s.name)}</span>
      <div className="mcprow__main">
        <span className="srow__label">
          {s.name}
          <StatusMark status={s.enabled ? s.status : 'stopped'} />
          <span className="orch__pill">{SCOPE_LABEL[s.source] || s.source}</span>
          {url && <span className="orch__pill">remoto</span>}
        </span>
        <span className={`srow__hint ${s.status === 'error' && s.enabled ? 'is-warn' : ''}`}>{detail}</span>
        <span className="mono srow__tools" title={joinCommandLine(s.spec)}>{url || joinCommandLine(s.spec)}</span>
      </div>
      <div className="ssec__actions mcprow__actions">
        {s.enabled && (
          <button className="ic" title="Reiniciar" disabled={busy} onClick={async () => { setBusy(true); await start(s.name).finally(() => setBusy(false)); }}>
            {busy || s.status === 'starting' ? <SpinRing size={13} /> : <IconRefresh size={14} />}
          </button>
        )}
        <button className="ic" title="Editar" onClick={() => onEdit(s)}><IconPencil size={13} /></button>
        {confirm
          ? <button className="lk is-danger" onClick={remove} onBlur={() => setConfirm(false)} autoFocus>¿Quitar?</button>
          : <button className="ic" title="Quitar" onClick={() => setConfirm(true)}><IconTrash size={13} /></button>}
        <Switch checked={s.enabled} onChange={(v) => setEnabled(s.name, v)} label={`Activar ${s.name}`} />
      </div>
    </div>
  );
}

export function McpPage() {
  const { servers, errors, loaded, load } = useMcpStore();
  const root = useAppStore((s) => s.workspaceRoot);
  const [panel, setPanel] = useState(null); // null | 'add' | 'import' | { edit: entry }
  const [flash, setFlash] = useState('');

  useEffect(() => { if (!loaded) load(root).catch(() => {}); }, [loaded, load, root]);

  const list = useMemo(() => Object.values(servers).sort((a, b) => a.name.localeCompare(b.name)), [servers]);
  const ready = list.filter((s) => s.enabled && s.status === 'ready');
  const tools = ready.reduce((n, s) => n + s.tools.length, 0);

  const done = (names) => {
    setPanel(null);
    if (names?.length) setFlash(`${names.join(', ')} guardado${names.length === 1 ? '' : 's'}. Arrancando…`);
  };
  useEffect(() => { if (!flash) return undefined; const t = setTimeout(() => setFlash(''), 4000); return () => clearTimeout(t); }, [flash]);

  const openGlobal = () => invoke('mcp_open_user_config').catch((e) => setFlash(String(e)));
  const openProject = async () => {
    const sep = root.includes('\\') ? '\\' : '/';
    useFileViewStore.getState().open(`${root}${sep}.lixbon${sep}mcp.json`);
  };
  const hasProject = list.some((s) => s.source === 'proyecto');

  return (
    <div className="spage">
      <PageHead icon={IconPuzzle} title="Servidores MCP" sub="Herramientas externas para el agente de Lixbon: GitHub, bases de datos, navegador, búsqueda…" />

      <section className="ssec rise rise--1">
        <div className="ssec__row">
          <span className="ssec__label">
            Instalados{list.length ? ` · ${list.length}` : ''}{ready.length ? ` · ${tools} herramientas disponibles` : ''}
          </span>
          <div className="panelhead__fill" />
          <button className="lk" onClick={() => setPanel(panel === 'import' ? null : 'import')}><IconDownload size={12} /> Importar</button>
          <button className="lk is-accent" onClick={() => setPanel(panel === 'add' ? null : 'add')}><IconPlus size={12} /> Añadir servidor</button>
        </div>

        {panel === 'add' && <ServerForm root={root} onDone={done} />}
        {panel?.edit && <ServerForm key={panel.edit.name} editing={panel.edit} root={root} onDone={done} />}
        {panel === 'import' && <ImportPanel root={root} installed={servers} onDone={done} />}
        {flash && <span className="srow__hint mcp__flash">{flash}</span>}

        <div className="ssec ssec--card ssec--rows">
          {errors.map((e) => <p key={e} className="mcpf__error">{e}</p>)}
          {!list.length && (
            <div className="mcp__empty">
              <span className="srow__label">Aún no hay servidores</span>
              <span className="srow__hint">Añade uno con su comando o su URL, usa una plantilla o importa los que ya tengas en Claude Code, Cursor o VS Code.</span>
            </div>
          )}
          {list.map((s) => <ServerRow key={s.name} s={s} root={root} onEdit={(entry) => setPanel({ edit: entry })} />)}
        </div>
      </section>

      <section className="ssec rise rise--2">
        <span className="ssec__label">Archivos de configuración</span>
        <div className="ssec ssec--card ssec--rows">
          <div className="srow">
            <div className="srow__text">
              <span className="srow__label">Global</span>
              <span className="mono srow__tools">~/.lixbon/mcp.json · para todos tus proyectos</span>
            </div>
            <button className="lk" onClick={openGlobal}><IconExternal size={12} /> Abrir</button>
          </div>
          {root && (
            <div className="srow">
              <div className="srow__text">
                <span className="srow__label">Este proyecto</span>
                <span className="mono srow__tools">.lixbon/mcp.json · pisa a los globales con el mismo nombre</span>
              </div>
              {hasProject && <button className="lk" onClick={openProject}>Abrir en el editor</button>}
            </div>
          )}
          <span className="srow__hint orch__intro">
            Las sesiones de Claude Code usan sus propios MCP. Para verlos, escribe /mcp en su chat; para usarlos también aquí, impórtalos.
          </span>
        </div>
      </section>
    </div>
  );
}
