// Settings.jsx — Ajustes dentro de la ventana flotante. Era una única columna
// con diez paneles seguidos; ahora se navega por secciones (una categoría de
// configuración por sección) con un buscador que filtra la lista.
import { useMemo, useState } from 'react';
import { AccountPanel } from './panels/AccountPanel';
import { AppearancePanel } from './panels/AppearancePanel';
import { EditorPanel } from './panels/EditorPanel';
import { AiPanel } from './panels/AiPanel';
import { LanguagePanel } from './panels/LanguagePanel';
import { AgentPanel } from './panels/AgentPanel';
import { IndexPanel } from './panels/IndexPanel';
import { AdvancedPanel } from './panels/AdvancedPanel';
import { Keybindings } from './Keybindings';
import {
  IconUser, IconEye, IconFileCode, IconChat, IconPuzzle, IconBook, IconGear, IconTerminal, IconList,
} from '../../components/Icons';

const SECTIONS = [
  {
    id: 'account', label: 'Cuenta', icon: IconUser, Panel: AccountPanel,
    keywords: 'perfil plan api key sesion correo',
  },
  {
    id: 'appearance', label: 'Apariencia', icon: IconEye, Panel: AppearancePanel,
    keywords: 'tema claro oscuro fuente tamaño letra',
  },
  {
    id: 'editor', label: 'Editor', icon: IconFileCode, Panel: EditorPanel,
    keywords: 'autoguardado formatear tabulador espacios indentacion',
  },
  {
    id: 'lsp', label: 'Lenguajes', icon: IconBook, Panel: LanguagePanel,
    keywords: 'lsp servidor lenguaje pyright rust-analyzer gopls definicion hover',
  },
  {
    id: 'ai', label: 'IA', icon: IconChat, Panel: AiPanel,
    keywords: 'autocompletado ghost fim vision modelo contexto',
  },
  {
    id: 'agent', label: 'Agente', icon: IconPuzzle, Panel: AgentPanel,
    keywords: 'agente permisos aprobar comandos herramientas',
  },
  {
    id: 'index', label: 'Índice (RAG)', icon: IconList, Panel: IndexPanel,
    keywords: 'rag embeddings indice codebase semantico',
  },
  {
    id: 'keys', label: 'Atajos', icon: IconTerminal, Panel: Keybindings,
    keywords: 'atajos teclado keybindings combinacion',
  },
  {
    id: 'advanced', label: 'Avanzado', icon: IconGear, Panel: AdvancedPanel,
    keywords: 'servidor gateway url actualizaciones version',
  },
];

export function Settings({ initialSection }) {
  const [active, setActive] = useState(initialSection || 'account');
  const [query, setQuery] = useState('');

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTIONS;
    return SECTIONS.filter(
      (s) => s.label.toLowerCase().includes(q) || s.keywords.includes(q),
    );
  }, [query]);

  // Si el filtro deja fuera la sección abierta, saltar a la primera que quede.
  const current = matches.find((s) => s.id === active) || matches[0] || SECTIONS[0];
  const Panel = current.Panel;

  return (
    <div className="settings-shell">
      <nav className="settings-nav">
        <input
          className="settings-nav__search"
          type="search"
          placeholder="Buscar ajuste…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        {matches.map((s) => {
          const Icon = s.icon;
          return (
            <button
              key={s.id}
              className={`settings-nav__item ${current.id === s.id ? 'is-active' : ''}`}
              onClick={() => setActive(s.id)}
            >
              <Icon size={15} />
              {s.label}
            </button>
          );
        })}
        {matches.length === 0 && (
          <p className="settings__hint settings-nav__empty">Nada coincide.</p>
        )}
      </nav>

      <div className="settings-pane">
        <Panel />
      </div>
    </div>
  );
}
