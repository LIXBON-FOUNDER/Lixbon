// SettingsPage.jsx — Ajustes a pantalla completa: navegación con indicador
// deslizante a la izquierda y la sección elegida centrada.
import { useEffect, useMemo, useState } from 'react';
import { useWorkbenchStore } from '../store/workbenchStore';
import { Panel } from '../layout/Panel';
import { ProfilePage } from '../sections/Settings/pages/ProfilePage';
import { UsagePage } from '../sections/Settings/pages/UsagePage';
import { AgentPage } from '../sections/Settings/pages/AgentPage';
import { ModelsPage } from '../sections/Settings/pages/ModelsPage';
import { EditorAdvancedPage } from '../sections/Settings/pages/EditorAdvancedPage';
import { Keybindings } from '../sections/Settings/Keybindings';
import { getAppVersion } from '../lib/tauri';
import { IconChevronLeft, IconSearch } from '../components/Icons';

const SECTIONS = [
  { id: 'profile', label: 'Perfil y cuenta', keywords: 'perfil nombre foto api key claves sesion cerrar', Page: ProfilePage },
  { id: 'usage', label: 'Uso y límites', keywords: 'uso consumo cupo sesion semana tokens plan', Page: UsagePage },
  { id: 'agent', label: 'Agente y permisos', keywords: 'agente permisos aprobar comandos herramientas nativas autonomia modo', Page: AgentPage },
  { id: 'models', label: 'Modelos', keywords: 'modelos roles vision contexto ventana chat embeddings', Page: ModelsPage },
  { id: 'editor', label: 'Editor y avanzado', keywords: 'editor fuente tabulacion ajuste linea terminal shell indice rag servidor gateway actualizaciones version', Page: EditorAdvancedPage },
  { id: 'keys', label: 'Atajos de teclado', keywords: 'atajos teclado keybindings', Page: Keybindings, legacy: true, title: 'Atajos de teclado' },
];
const ROW_H = 34;

export function SettingsPage() {
  const { settingsSection, setSettingsSection, closePage, setMode, showSide } = useWorkbenchStore();
  const [query, setQuery] = useState('');
  const [version, setVersion] = useState('');

  useEffect(() => { getAppVersion().then(setVersion).catch(() => {}); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.confirm__overlay')) closePage(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closePage]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? SECTIONS.filter((s) => s.label.toLowerCase().includes(q) || s.keywords.includes(q)) : SECTIONS;
  }, [query]);
  const current = SECTIONS.find((s) => s.id === settingsSection) || SECTIONS[0];
  const idx = visible.findIndex((s) => s.id === current.id);
  const Page = current.Page;

  return (
    <div className="wb wb--settings">
      <Panel id="settingsnav" className="settingsnav" style={{ width: 248 }}>
        <button className="lk settingsnav__back" onClick={closePage}><IconChevronLeft size={14} /> Volver <kbd>Esc</kbd></button>
        <div className="field field--strong settingsnav__search">
          <IconSearch size={13} />
          <input value={query} placeholder="Buscar ajustes" onChange={(e) => setQuery(e.target.value)} />
        </div>
        <nav className="settingsnav__list">
          {idx >= 0 && <span className="settingsnav__thumb" style={{ transform: `translateY(${idx * ROW_H}px)` }} />}
          {visible.map((s) => (
            <button key={s.id} className={`settingsnav__item ${s.id === current.id ? 'is-active' : ''}`} onClick={() => setSettingsSection(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>
        <button className="lk settingsnav__link" onClick={() => { setMode('editor'); showSide('extensions'); }}>Extensiones y MCP</button>
        <div className="panelhead__fill" />
        {version && <span className="mono settingsnav__ver">lixbon desktop {version}</span>}
      </Panel>
      <div className="gutter gutter--x" style={{ cursor: 'default' }} />
      <Panel id="settings" className="wb__grow settingsbody scroll">
        <div className="settingsbody__inner" key={current.id}>
          {current.legacy ? (
            <div className="spage">
              <div className="spage__head rise">
                <div className="spage__title">
                  <span className="spage__h1">{current.title}</span>
                  {current.sub && <span className="spage__sub">{current.sub}</span>}
                </div>
              </div>
              <div className="rise rise--1 legacyset"><Page /></div>
            </div>
          ) : <Page />}
        </div>
      </Panel>
    </div>
  );
}
