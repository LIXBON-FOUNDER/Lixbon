// SettingsPage.jsx — Ajustes en una ventana centrada sobre el modo activo:
// navegación por grupos con icono e indicador deslizante a la izquierda y la
// sección elegida a la derecha. Esc o un clic fuera la cierran, y el modo de
// debajo sigue donde estaba. Con la ventana estrecha la navegación pasa a un
// selector encima de la sección.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useWorkbenchStore } from '../store/workbenchStore';
import { Select } from '../components/Select';
import { ProfilePage } from '../sections/Settings/pages/ProfilePage';
import { UsagePage } from '../sections/Settings/pages/UsagePage';
import { AgentPage } from '../sections/Settings/pages/AgentPage';
import { EditorPage } from '../sections/Settings/pages/EditorPage';
import { ServerPage } from '../sections/Settings/pages/ServerPage';
import { OrchestratorPage } from '../sections/Settings/pages/OrchestratorPage';
import { McpPage } from '../sections/Settings/pages/McpPage';
import { SkillsPage } from '../sections/Settings/pages/SkillsPage';
import { GitPage } from '../sections/Settings/pages/GitPage';
import { MascotaPage } from '../sections/Settings/pages/MascotaPage';
import { Keybindings } from '../sections/Settings/Keybindings';
import { getAppVersion } from '../lib/tauri';
import {
  IconX, IconSearch, IconUser, IconChart, IconShield, IconNodes, IconPuzzle,
  IconCode, IconKeyboard, IconServer, IconExtensions, IconMascota, IconGitBranch, IconBook,
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
    { id: 'skills', label: 'Skills', icon: IconBook, keywords: 'skills comandos catalogo instalar adversary marketing calificar version', Page: SkillsPage },
  ] },
  { label: 'Espacio de trabajo', items: [
    { id: 'editor', label: 'Interfaz y editor', icon: IconCode, keywords: 'interfaz tamaño zoom letra tipografia editor fuente tabulacion ajuste linea terminal shell', Page: EditorPage },
    { id: 'git', label: 'Git', icon: IconGitBranch, keywords: 'git commit mensaje conventional commits idioma generar claude lixbon', Page: GitPage },
    { id: 'keys', label: 'Atajos de teclado', icon: IconKeyboard, keywords: 'atajos teclado keybindings combinacion', Page: Keybindings },
    { id: 'mascota', label: 'Mascota', icon: IconMascota, keywords: 'mascota gael leya pixel animacion kart latigo aviso flotante dormir', Page: MascotaPage },
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
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.confirm__overlay, .modal__overlay:not(.sm__overlay), .pop, .select__list')) closePage(); };
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
    <div className="modal__overlay sm__overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) closePage(); }}>
      <div className="sm" role="dialog" aria-modal="true" aria-label="Ajustes">
        <header className="sm__head">
          <h2 className="sm__title">Ajustes</h2>
          <div className="sm__fill" />
          <div className="field sm__search">
            <IconSearch size={15} />
            <input value={query} placeholder="Buscar ajustes" aria-label="Buscar ajustes" onChange={(e) => setQuery(e.target.value)} />
          </div>
          <button className="ic" onClick={closePage} title="Cerrar (Esc)" aria-label="Cerrar"><IconX size={17} /></button>
        </header>
        <div className="sm__main">
          <nav className="sm__nav" aria-label="Secciones de ajustes">
            <div className="sm__list scroll">
              {thumb && <span className="sm__thumb" style={{ transform: `translateY(${thumb.top}px)`, height: thumb.height }} />}
              {groups.length === 0 && <span className="sm__empty">Nada coincide con «{query}»</span>}
              {groups.map((g) => (
                <div key={g.label} className="sm__group">
                  <span className="sm__grouplabel">{g.label}</span>
                  {g.items.map((s) => {
                    const Icon = s.icon;
                    return (
                      <button
                        key={s.id}
                        ref={(el) => { itemRefs.current[s.id] = el; }}
                        className={`sm__item ${s.id === current.id ? 'is-active' : ''}`}
                        onClick={() => setSettingsSection(s.id)}
                        aria-current={s.id === current.id ? 'page' : undefined}
                      >
                        <Icon size={16} />
                        <span>{s.label}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            <button className="sm__link" onClick={() => { closePage(); setMode('editor'); showSide('extensions'); }}>
              <IconExtensions size={15} /> Extensiones
            </button>
            {version && <span className="mono sm__ver">lixbon desktop {version}</span>}
          </nav>
          <div className="sm__page">
            <div className="sm__pick">
              <Select
                className="select--fill"
                value={current.id}
                onChange={setSettingsSection}
                options={SECTIONS.map((x) => ({ value: x.id, label: x.label }))}
              />
            </div>
            <div className="sm__body scroll">
              <div className="settingsbody__inner" key={current.id}>
                <Page />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
