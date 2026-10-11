// engines.jsx — los motores con los que se habla desde el modo Agente, en un solo sitio.
// kind 'chat': conversación dentro de Lixbon; 'terminal': la TUI de la CLI en una pestaña.
// Añadir un motor es una entrada aquí (y su implementación); el resto de la interfaz lo lee de este registro.
import { LogoMark, ClaudeMark } from '../components/Logo';
import { ProviderMark } from '../orch/agent/ProviderMark';

const CodexMark = ({ size }) => <ProviderMark provider="codex" size={size} />;

export const ENGINES = Object.freeze({
  lixbon: {
    id: 'lixbon', label: 'Lixbon', short: 'Lixbon', kind: 'chat', Mark: LogoMark, dock: false,
    emptyTitle: '¿En qué trabajamos hoy?',
    emptyHint: 'El agente puede leer, buscar y editar tu carpeta de trabajo, y ejecutar comandos con tu permiso. Menciona archivos con @ y usa / para comandos.',
  },
  claude: {
    id: 'claude', label: 'Claude Code', short: 'Claude', kind: 'chat', Mark: ClaudeMark, dock: true,
    emptyTitle: 'Claude Code',
    emptyHint: 'Usa tu instalación y tu cuenta de Claude Code sobre esta carpeta. Sus cambios, lecturas y comandos aparecen en los paneles de la derecha, y los permisos se piden aquí.',
  },
  codex: { id: 'codex', label: 'Codex', short: 'Codex', kind: 'terminal', Mark: CodexMark, dock: false },
});

/** Un motor desconocido o ausente se trata como el agente de Lixbon. */
export const engineOf = (id) => ENGINES[id || 'lixbon'] || ENGINES.lixbon;

export const ENGINE_IDS = Object.freeze(Object.keys(ENGINES));
/** Motores de chat que no son el agente de Lixbon (que va fijo en «+ Nuevo»). */
export const EXTRA_CHAT_ENGINES = Object.freeze(ENGINE_IDS.filter((id) => ENGINES[id].kind === 'chat' && id !== 'lixbon'));
export const TERMINAL_ENGINE_IDS = Object.freeze(ENGINE_IDS.filter((id) => ENGINES[id].kind === 'terminal'));
