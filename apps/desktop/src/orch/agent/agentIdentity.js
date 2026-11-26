import { AGENT_LABELS, ROLE_LABELS } from '../../store/orchStore';

const SERVICE_NAMES = { openai: 'OpenAI', chatgpt: 'ChatGPT', anthropic: 'Claude', 'claude-code': 'Claude Code' };
export const providerName = (id) => AGENT_LABELS[id] || SERVICE_NAMES[id] || id || 'Agente';
export const roleName = (role) => (role ? ROLE_LABELS[role] || role : null);

/** `modelo · esfuerzo`, o vacío. Lo que se muestra es lo que pidió la persona; el modelo que respondió lo cuenta ModelInfo. */
export const modelDetail = ({ model, effort }) => [model, effort].filter(Boolean).join(' · ');

export const folderName = (path) => (path ? String(path).replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '');
