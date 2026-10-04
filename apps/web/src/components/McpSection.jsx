// McpSection.jsx — Ajustes › MCP: conecta el servidor MCP de Lixbon a cada
// agente con la configuración ya armada (URL y API key) en el formato exacto de
// cada cliente, para copiar o instalar con un clic.
import { useState } from 'react';
import { useT } from '../i18n/useT';
import { api } from '../lib/api';
import { IconCheck, IconCopy, IconExternal, IconPlus } from './Icons';

const NOMBRE = 'lixbon';
const SIN_CLAVE = 'lixbon_sk_TU_CLAVE';
const json = (obj) => JSON.stringify(obj, null, 2);
// btoa solo admite Latin-1; la configuración es ASCII, pero así no rompe nunca.
const base64 = (texto) => btoa(String.fromCharCode(...new TextEncoder().encode(texto)));

// Formatos verificados con la documentación de cada cliente (octubre 2026).
function clientes(url, key) {
  const headers = { Authorization: `Bearer ${key}` };
  return [
    {
      id: 'claude', nombre: 'Claude Code',
      bloques: [{ tipo: 'comando', codigo: `claude mcp add --transport http ${NOMBRE} ${url} --header "Authorization: Bearer ${key}" -s user` }],
      pasos: ['claudeStep1', 'claudeStep2'],
    },
    {
      id: 'cursor', nombre: 'Cursor',
      accion: { etiqueta: 'cursorAction', href: `cursor://anysphere.cursor-deeplink/mcp/install?name=${NOMBRE}&config=${base64(JSON.stringify({ url, headers }))}` },
      bloques: [{ tipo: 'archivo', ruta: '~/.cursor/mcp.json', codigo: json({ mcpServers: { [NOMBRE]: { url, headers } } }) }],
      pasos: ['cursorStep1', 'mergeStep', 'restartStep'],
    },
    {
      id: 'vscode', nombre: 'VS Code',
      accion: { etiqueta: 'vscodeAction', href: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: NOMBRE, type: 'http', url, headers }))}` },
      bloques: [{ tipo: 'archivo', ruta: 'mcp.json', codigo: json({ servers: { [NOMBRE]: { type: 'http', url, headers } } }) }],
      pasos: ['vscodeStep1', 'vscodeStep2'],
    },
    {
      id: 'antigravity', nombre: 'Antigravity',
      bloques: [{ tipo: 'archivo', ruta: '~/.gemini/config/mcp_config.json', codigo: json({ mcpServers: { [NOMBRE]: { serverUrl: url, headers } } }) }],
      pasos: ['antigravityStep1', 'mergeStep'],
    },
    {
      id: 'codex', nombre: 'Codex',
      bloques: [{ tipo: 'archivo', ruta: '~/.codex/config.toml', codigo: `[mcp_servers.${NOMBRE}]\nurl = "${url}"\nhttp_headers = { "Authorization" = "Bearer ${key}" }` }],
      pasos: ['codexStep1', 'restartStep'],
    },
    {
      id: 'gemini', nombre: 'Gemini CLI',
      bloques: [{ tipo: 'archivo', ruta: '~/.gemini/settings.json', codigo: json({ mcpServers: { [NOMBRE]: { httpUrl: url, headers } } }) }],
      pasos: ['geminiStep1', 'mergeStep'],
    },
    {
      id: 'windsurf', nombre: 'Windsurf',
      bloques: [{ tipo: 'archivo', ruta: '~/.codeium/windsurf/mcp_config.json', codigo: json({ mcpServers: { [NOMBRE]: { serverUrl: url, headers } } }) }],
      pasos: ['mergeStep', 'restartStep'],
    },
    {
      id: 'opencode', nombre: 'OpenCode',
      bloques: [{ tipo: 'comando', codigo: `opencode mcp add ${NOMBRE} --url ${url} --header "Authorization=Bearer ${key}" --global` }],
      pasos: ['restartStep'],
    },
    {
      id: 'lixbon', nombre: 'Lixbon CLI',
      bloques: [{ tipo: 'comando', codigo: 'lixbon setup' }],
      pasos: ['lixbonStep1', 'lixbonStep2'],
    },
  ];
}

function Copiable({ codigo, ruta, t }) {
  const [copiado, setCopiado] = useState(false);
  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(codigo);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1600);
    } catch { /* sin portapapeles */ }
  };
  return (
    <div className="mcp-code">
      <div className="mcp-code__head">
        <span className="mono">{ruta || t('command')}</span>
        <button type="button" className="mcp-code__copy" onClick={copiar}>
          {copiado ? <IconCheck size={13} /> : <IconCopy size={13} />} {copiado ? t('copied') : t('copy')}
        </button>
      </div>
      <pre className="mcp-code__body"><code>{codigo}</code></pre>
    </div>
  );
}

export function McpSection({ onKeysChanged }) {
  const t = useT('mcp');
  const url = `${window.location.origin}/mcp`;
  const [key, setKey] = useState('');
  const [pegada, setPegada] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [activo, setActivo] = useState('claude');

  const crearClave = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api.post('/api/keys', { name: 'MCP' });
      setKey(res.data.api_key);
      onKeysChanged?.();
    } catch (err) {
      const d = err.response?.data?.detail;
      setError((d && d.message) || (typeof d === 'string' ? d : t('createError')));
    } finally {
      setBusy(false);
    }
  };

  const clave = key || (pegada.trim().startsWith('lixbon_sk_') ? pegada.trim() : '') || SIN_CLAVE;
  const lista = clientes(url, clave);
  const cliente = lista.find((c) => c.id === activo) || lista[0];
  const sinClave = clave === SIN_CLAVE && cliente.id !== 'lixbon';

  return (
    <>
      <div className="set-card">
        <h2 className="set-title">{t('title')}</h2>
        <p className="card__muted mcp-lead">{t('lead')}</p>
        <Copiable codigo={url} ruta={t('serverUrl')} t={t} />
        <div className="mcp-key">
          {key ? (
            <div className="key-reveal">
              <div>
                <strong>{t('keyCreated')}</strong>
                <code>{key}</code>
              </div>
            </div>
          ) : (
            <>
              <button className="pill-btn pill-btn--primary set-btn" onClick={crearClave} disabled={busy}>
                <IconPlus size={14} /> {busy ? t('creating') : t('createKey')}
              </button>
              <span className="card__muted">{t('or')}</span>
              <input className="mcp-key__input mono" value={pegada} onChange={(e) => setPegada(e.target.value)}
                placeholder={t('pastePlaceholder')} aria-label={t('pastePlaceholder')} spellCheck={false} autoComplete="off" />
            </>
          )}
        </div>
        {error && <p className="page__error" role="alert">{error}</p>}
        <p className="card__muted mcp-note">{t('keyNote')}</p>
      </div>

      <div className="set-card">
        <h2 className="set-title">{t('clientsTitle')}</h2>
        <div className="mcp-tabs" role="tablist" aria-label={t('clientsTitle')}>
          {lista.map((c) => (
            <button key={c.id} role="tab" aria-selected={c.id === cliente.id} className={c.id === cliente.id ? 'is-on' : ''} onClick={() => setActivo(c.id)}>
              {c.nombre}
            </button>
          ))}
        </div>
        <div className="mcp-client" role="tabpanel">
          {sinClave && <p className="mcp-warn">{t('needKey')}</p>}
          {cliente.accion && (
            <a className={`pill-btn pill-btn--primary set-btn mcp-client__action ${sinClave ? 'is-disabled' : ''}`}
              href={sinClave ? undefined : cliente.accion.href} aria-disabled={sinClave}>
              <IconExternal size={14} /> {t(cliente.accion.etiqueta)}
            </a>
          )}
          {cliente.bloques.map((b) => <Copiable key={b.codigo} codigo={b.codigo} ruta={b.tipo === 'archivo' ? b.ruta : null} t={t} />)}
          <ol className="mcp-steps">
            {cliente.pasos.map((p) => <li key={p}>{t(p)}</li>)}
            {cliente.id !== 'lixbon' && <li>{t('checkStep')}</li>}
          </ol>
        </div>
      </div>
    </>
  );
}
