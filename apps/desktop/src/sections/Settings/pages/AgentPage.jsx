// AgentPage.jsx — Ajustes → Agente y permisos: modo con el que empieza cada
// conversación, un preajuste de autonomía y el permiso por tipo de herramienta.
import { useState } from 'react';
import { useChatStore, CHAT_MODES } from '../../../store/chatStore';
import { useMcpStore } from '../../../store/mcpStore';
import { Segmented } from '../../../components/Segmented';
import { Switch } from '../../../components/Switch';

const CATEGORIES = [
  { id: 'read', label: 'Leer y buscar', hint: 'Leer archivos, listar, buscar texto y la búsqueda semántica.', tools: 'read_file · list_files · search · outline' },
  { id: 'edit', label: 'Editar archivos', hint: 'Crear y modificar archivos. Todo queda revisable y reversible.', tools: 'edit_file · write_file · multi_edit · rename_file' },
  { id: 'delete', label: 'Borrar archivos', hint: 'Se puede revertir desde el chat, pero conviene verlo antes.', tools: 'delete_file' },
  { id: 'command', label: 'Ejecutar comandos', hint: 'Aun en "Permitir", los que instalan paquetes, encadenan o ejecutan código externo preguntan siempre.', tools: 'run_command' },
  { id: 'web', label: 'Web', hint: 'Descargar páginas y buscar en internet.', tools: 'fetch_url · web_search' },
  { id: 'mcp', label: 'Servidores MCP', hint: 'Herramientas de tus extensiones.', tools: null },
];

const PRESETS = {
  careful: { read: 'allow', edit: 'ask', delete: 'ask', command: 'ask', web: 'ask', mcp: 'ask' },
  balanced: { read: 'allow', edit: 'allow', delete: 'ask', command: 'ask', web: 'allow', mcp: 'ask' },
  auto: { read: 'allow', edit: 'allow', delete: 'allow', command: 'allow', web: 'allow', mcp: 'allow' },
};

const POLICY_OPTIONS = [
  { value: 'allow', label: 'Permitir' },
  { value: 'ask', label: 'Preguntar' },
  { value: 'never', label: 'Nunca', tone: 'danger' },
];

export function AgentPage() {
  const {
    chatMode, setChatMode, nativeTools, setNativeTools,
    toolPolicy, setToolPolicy, commandAllowlist, setCommandAllowlist,
  } = useChatStore();
  const mcpTools = useMcpStore((s) => s.agentTools().length);
  const [allowDraft, setAllowDraft] = useState(() => commandAllowlist.join('\n'));
  const preset = Object.entries(PRESETS).find(([, p]) => Object.keys(p).every((k) => p[k] === toolPolicy[k]))?.[0] || 'custom';
  const applyPreset = (id) => Object.entries(PRESETS[id]).forEach(([k, v]) => setToolPolicy(k, v));

  return (
    <div className="spage">
      <div className="spage__head rise">
        <div className="spage__title">
          <span className="spage__h1">Agente y permisos</span>
          <span className="spage__sub">Decide qué puede hacer el agente sin preguntarte.</span>
        </div>
      </div>

      <section className="ssec ssec--card rise rise--1">
        <div className="srow">
          <div className="srow__text">
            <span className="srow__label">Modo por defecto</span>
            <span className="srow__hint">Se alterna en el chat con Shift+Tab o Ctrl+.</span>
          </div>
          <Segmented
            width={96}
            value={chatMode}
            onChange={setChatMode}
            options={CHAT_MODES.map((m) => ({ value: m.id, label: m.label }))}
          />
        </div>
        <div className="srow">
          <div className="srow__text">
            <span className="srow__label">Autonomía</span>
            <span className="srow__hint">{preset === 'custom' ? 'Personalizada: ajustada herramienta a herramienta.' : 'Un punto de partida; afina abajo cada tipo de herramienta.'}</span>
          </div>
          <Segmented
            width={96}
            value={preset}
            onChange={applyPreset}
            options={[{ value: 'careful', label: 'Cauteloso' }, { value: 'balanced', label: 'Equilibrado' }, { value: 'auto', label: 'Autónomo' }]}
          />
        </div>
      </section>

      <section className="ssec rise rise--2">
        <span className="ssec__label">Herramientas</span>
        <div className="ssec ssec--card ssec--rows">
          {CATEGORIES.map((c) => (
            <div key={c.id} className="srow">
              <div className="srow__text">
                <span className="srow__label">{c.label}</span>
                <span className="srow__hint">{c.hint}</span>
                <span className="mono srow__tools">{c.tools ?? (mcpTools ? `${mcpTools} herramientas activas` : 'ninguna activa')}</span>
              </div>
              <Segmented size="sm" width={78} value={toolPolicy[c.id] || 'ask'} onChange={(v) => setToolPolicy(c.id, v)} options={POLICY_OPTIONS} />
            </div>
          ))}
        </div>
      </section>

      <section className="ssec rise rise--3">
        <span className="ssec__label">Comandos permitidos sin preguntar</span>
        <div className="ssec ssec--card">
          <span className="srow__hint">Un prefijo por línea, por ejemplo «npm test». Solo cuenta cuando "Ejecutar comandos" está en Preguntar; los que llevan &&, |, ; o &gt; preguntan siempre.</span>
          <textarea
            className="stextarea mono"
            rows={5}
            spellCheck={false}
            value={allowDraft}
            onChange={(e) => setAllowDraft(e.target.value)}
            onBlur={() => setCommandAllowlist(allowDraft.split('\n'))}
          />
        </div>
      </section>

      <section className="ssec ssec--card rise rise--3">
        <div className="srow">
          <div className="srow__text">
            <span className="srow__label">Herramientas nativas</span>
            <span className="srow__hint">Usa los tool_calls del modelo en vez del protocolo de texto. Más fiable si el modelo declara la capacidad «tools».</span>
          </div>
          <Switch checked={nativeTools} onChange={setNativeTools} label="Herramientas nativas" />
        </div>
      </section>
    </div>
  );
}
