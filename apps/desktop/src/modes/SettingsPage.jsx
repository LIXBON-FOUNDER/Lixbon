// SettingsPage.jsx — Ajustes a pantalla completa: navegación por grupos con
// icono e indicador deslizante a la izquierda, y la sección elegida centrada.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useWorkbenchStore } from '../store/workbenchStore';
import { Panel } from '../layout/Panel';
import { ProfilePage } from '../sections/Settings/pages/ProfilePage';
import { UsagePage } from '../sections/Settings/pages/UsagePage';
import { AgentPage } from '../sections/Settings/pages/AgentPage';
import { EditorPage } from '../sections/Settings/pages/EditorPage';
import { ServerPage } from '../sections/Settings/pages/ServerPage';
import { OrchestratorPage } from '../sections/Settings/pages/OrchestratorPage';
import { McpPage } from '../sections/Settings/pages/McpPage';
import { Keybindings } from '../sections/Settings/Keybindings';
import { getAppVersion } from '../lib/tauri';
import {
  IconChevronLeft, IconSearch, IconUser, IconChart, IconShield, IconNodes, IconPuzzle,
  IconCode, IconKeyboard, IconServer, IconExtensions,
} from '../components/Icons';

const GROUPS = [
  { label: 'Cuenta', items: [
    { id: 'profile', label: 'Perfil y cuenta', icon: IconUser, keywords: 'perfil nombre foto api key claves sesion cerrar eliminar', Page: ProfilePage },
    { id: 'usage', label: 'Uso y límites', icon: IconChart, keywords: 'uso consumo cupo sesion semana tokens plan', Page: UsagePage },
  ] },
  { label: 'Inteligencia', items: [
    { id: 'agent', label: 'Agente y permisos', icon: IconShield, keywords: 'agente permisos aprobar comandos permitidos allowlist herramientas autonomia modo', Page: AgentPage },
    { id: 'orch', label: 'Orquestador', icon: IconNodes, keywords: 'orquestador agentes coordinador hijos roles explorador implementador revisor skill lxo worktree experimental', Page: OrchestratorPage },
    { id: 'mcp', label: 'Servidores MCP', icon: IconPuzzle, keywords: 'mcp servidores extensiones herramientas github postgres playwright importar claude cursor vscode', Page: McpPage },
  ] },
  { label: 'Espacio de trabajo', items: [
    { id: 'editor', label: 'Interfaz y editor', icon: IconCode, keywords: 'interfaz tamaño zoom letra tipografia editor fuente tabulacion ajuste linea terminal shell', Page: EditorPage },
    { id: 'keys', label: 'Atajos de teclado', icon: IconKeyboard, keywords: 'atajos teclado keybindings combinacion', Page: Keybindings },
  ] },
  { label: 'Sistema', items: [
    { id: 'server', label: 'Conexión y versión', icon: IconServer, keywords: 'servidor gateway url tunel actualizaciones version', Page: ServerPage },
  ] },
];
const SECTIONS = GROUPS.flatMap((g) => g.items);

export function SettingsPage() {
  const { settingsSection, setSettingsSection, closePage, setMode, showSide } = useWorkbenchStore();
  const [query, setQuery] = useState('');
  const [version, setVersion] = useState('');
  const [thumb, setThumb] = useState(null);
  const itemRefs = useRef({});

  useEffect(() => { getAppVersion().then(setVersion).catch(() => {}); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.confirm__overlay')) closePage(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closePage]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GROUPS;
    return GROUPS
      .map((g) => ({ ...g, items: g.items.filter((s) => s.label.toLowerCase().includes(q) || s.keywords.includes(q)) }))
      .filter((g) => g.items.length);
  }, [query]);
  const current = SECTIONS.find((s) => s.id === settingsSection) || SECTIONS[0];
  const Page = current.Page;

  // Con grupos las filas no están a distancia fija: el indicador se coloca
  // donde está de verdad el botón activo.
  useLayoutEffect(() => {
    const el = itemRefs.current[current.id];
    setThumb(el ? { top: el.offsetTop, height: el.offsetHeight } : null);
  }, [current.id, groups]);

  return (
    <div className="wb wb--settings">
      <Panel id="settingsnav" className="settingsnav" style={{ width: 248 }}>
        <button className="lk settingsnav__back" onClick={closePage}><IconChevronLeft size={14} /> Volver <kbd>Esc</kbd></button>
        <div className="field field--strong settingsnav__search">
          <IconSearch size={13} />
          <input value={query} placeholder="Buscar ajustes" onChange={(e) => setQuery(e.target.value)} />
        </div>
        <nav className="settingsnav__list scroll">
          {thumb && <span className="settingsnav__thumb" style={{ transform: `translateY(${thumb.top}px)`, height: thumb.height }} />}
          {groups.length === 0 && <span className="settingsnav__empty">Nada coincide con «{query}»</span>}
          {groups.map((g) => (
            <div key={g.label} className="settingsnav__group">
              <span className="settingsnav__grouplabel">{g.label}</span>
              {g.items.map((s) => {
                const Icon = s.icon;
                return (
                  <button
                    key={s.id}
                    ref={(el) => { itemRefs.current[s.id] = el; }}
                    className={`settingsnav__item ${s.id === current.id ? 'is-active' : ''}`}
                    onClick={() => setSettingsSection(s.id)}
                  >
                    <Icon size={15} />
                    <span>{s.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <button className="lk settingsnav__link" onClick={() => { setMode('editor'); showSide('extensions'); }}>
          <IconExtensions size={13} /> Extensiones
        </button>
        {version && <span className="mono settingsnav__ver">lixbon desktop {version}</span>}
      </Panel>
      <div className="gutter gutter--x" style={{ cursor: 'default' }} />
      <Panel id="settings" className="wb__grow settingsbody scroll">
        <div className="settingsbody__inner" key={current.id}>
          <Page />
        </div>
      </Panel>
    </div>
  );
}
