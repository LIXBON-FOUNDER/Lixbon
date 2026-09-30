// AgentPage.jsx — Ajustes → Agente y permisos: modo con el que empieza cada
// conversación, un preajuste de autonomía, el permiso por tipo de herramienta
// y los comandos que se ejecutan sin preguntar.
import { useChatStore, CHAT_MODES } from '../../../store/chatStore';
import { useMcpStore } from '../../../store/mcpStore';
import { Segmented } from '../../../components/Segmented';
import { IconShield } from '../../../components/Icons';
import { PageHead, SectionHead } from '../SettingsParts';
import { CommandAllowlist } from '../CommandAllowlist';

const CATEGORIES = [
  { id: 'read', label: 'Leer y buscar', hint: 'Leer archivos, listar, buscar texto y ver la estructura del código.', tools: 'read_file · list_files · find_files · search · outline' },
  { id: 'edit', label: 'Editar archivos', hint: 'Crear y modificar archivos. Todo queda revisable y reversible.', tools: 'edit_file · write_file · multi_edit · rename_file' },
  { id: 'delete', label: 'Borrar archivos', hint: 'Se puede revertir desde el chat, pero conviene verlo antes.', tools: 'delete_file' },
  { id: 'command', label: 'Ejecutar comandos', hint: 'En Preguntar, los de la lista de abajo se ejecutan sin preguntar.', tools: 'run_command' },
  { id: 'web', label: 'Web', hint: 'Descargar páginas y buscar en internet.', tools: 'fetch_url · web_search' },
  { id: 'mcp', label: 'Servidores MCP', hint: 'Herramientas de tus extensiones.', tools: null },
];

const PRESETS = {
  careful: { read: 'allow', edit: 'ask', delete: 'ask', command: 'ask', web: 'ask', mcp: 'ask' },
  balanced: { read: 'allow', edit: 'allow', delete: 'ask', command: 'ask', web: 'allow', mcp: 'ask' },
  auto: { read: 'allow', edit: 'allow', delete: 'allow', command: 'allow', web: 'allow', mcp: 'allow' },
};

const PRESET_HINT = {
  careful: 'Solo lee sin preguntar; todo lo demás te lo consulta.',
  balanced: 'Lee, edita y busca en la web solo; pregunta antes de borrar, ejecutar o usar MCP.',
  auto: 'Hace todo sin preguntar. Los comandos peligrosos siguen pidiendo permiso.',
  custom: 'Personalizada: ajustada herramienta a herramienta.',
};

const POLICY_OPTIONS = [
  { value: 'allow', label: 'Permitir' },
  { value: 'ask', label: 'Preguntar' },
  { value: 'never', label: 'Nunca', tone: 'danger' },
];

export function AgentPage() {
  const {
    chatMode, setChatMode,
    toolPolicy, setToolPolicy, commandAllowlist, setCommandAllowlist,
  } = useChatStore();
  const mcpTools = useMcpStore((s) => s.agentTools().length);
  const preset = Object.entries(PRESETS).find(([, p]) => Object.keys(p).every((k) => p[k] === toolPolicy[k]))?.[0] || 'custom';
  const applyPreset = (id) => Object.entries(PRESETS[id]).forEach(([k, v]) => setToolPolicy(k, v));

  return (
    <div className="spage">
      <PageHead icon={IconShield} title="Agente y permisos" sub="Decide qué puede hacer el agente de Lixbon sin preguntarte." />

      <section className="ssec rise rise--1">
        <SectionHead label="Comportamiento" />
        <div className="ssec ssec--card ssec--rows">
          <div className="srow">
            <div className="srow__text">
              <span className="srow__label">Modo por defecto</span>
              <span className="srow__hint">Con el que empieza cada conversación. En el chat se alterna con Shift+Tab o Ctrl+.</span>
            </div>
            <Segmented width={96} value={chatMode} onChange={setChatMode} options={CHAT_MODES.map((m) => ({ value: m.id, label: m.label }))} />
          </div>
          <div className="srow">
            <div className="srow__text">
              <span className="srow__label">Autonomía</span>
              <span className="srow__hint">{PRESET_HINT[preset]}</span>
            </div>
            <Segmented
              width={96}
              value={preset}
              onChange={applyPreset}
              options={[{ value: 'careful', label: 'Cauteloso' }, { value: 'balanced', label: 'Equilibrado' }, { value: 'auto', label: 'Autónomo' }]}
            />
          </div>
        </div>
      </section>

      <section className="ssec rise rise--2">
        <SectionHead label="Permisos por herramienta" hint="Afinan el preajuste de autonomía. Cambiar uno lo convierte en personalizado." />
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

      <CommandAllowlist list={commandAllowlist} onChange={setCommandAllowlist} commandPolicy={toolPolicy.command || 'ask'} />
    </div>
  );
}
