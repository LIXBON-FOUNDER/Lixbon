// main.jsx — entrada aislada de la vista previa del ADE (ade-preview.html).
// No importa App, appStore ni orchStore: solo el ADE, un MockAdeClient y el CSS global de tokens.
import React, { useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/jetbrains-mono';
import '../../styles/base.css';
import '../../styles/studio.css';
import './preview.css';
import { AdeApp } from '../screens/AdeApp';
import { createMockAdeClient } from '../client/MockAdeClient';
import { createNullHost } from '../host/AdeHost';

const ANCHOS = [
  { id: 'auto', label: 'Ajustado', width: '100%' },
  { id: 'wide', label: 'Amplio 1280', width: '1280px' },
  { id: 'narrow', label: 'Estrecho 800', width: '800px' },
  { id: 'mobile', label: 'Móvil 375', width: '375px' },
];
const SUPERFICIES = [
  { id: 'desktop', label: 'Desktop' },
  { id: 'mobile', label: 'Móvil (alcance)' },
];
const WORKTREE_IDE = '%LOCALAPPDATA%/Lixbon/worktrees/prj_orbita/att_checkout_2/src/checkout/Formulario.jsx';

function Preview() {
  const [ancho, setAncho] = useState('auto');
  const [superficie, setSuperficie] = useState('desktop');
  const [ideAbierto, setIdeAbierto] = useState(false);
  const [tema, setTema] = useState(document.documentElement.dataset.theme || 'dark');
  const client = useMemo(() => createMockAdeClient({ clientKind: superficie, latencyMs: 250 }), [superficie]);
  const host = useMemo(() => createNullHost(), []);
  const marco = ANCHOS.find((a) => a.id === ancho);

  return (
    <div className="pv">
      <div className="pv-bar" role="toolbar" aria-label="Controles de la vista previa">
        <strong>Vista previa del ADE</strong>
        <span className="pv-sep" />
        <span className="pv-group" role="group" aria-label="Ancho del contenedor">
          {ANCHOS.map((a) => <button key={a.id} type="button" className={ancho === a.id ? 'is-on' : ''} onClick={() => setAncho(a.id)}>{a.label}</button>)}
        </span>
        <span className="pv-group" role="group" aria-label="Superficie simulada">
          {SUPERFICIES.map((s) => <button key={s.id} type="button" className={superficie === s.id ? 'is-on' : ''} onClick={() => setSuperficie(s.id)}>{s.label}</button>)}
        </span>
        <button type="button" className={ideAbierto ? 'is-on' : ''} onClick={() => setIdeAbierto((v) => !v)}>IDE con un archivo del intento abierto</button>
        <button
          type="button"
          onClick={() => {
            const siguiente = tema === 'dark' ? 'light' : 'dark';
            document.documentElement.dataset.theme = siguiente;
            setTema(siguiente);
          }}
        >
          Tema: {tema === 'dark' ? 'oscuro' : 'claro'}
        </button>
      </div>
      <div className="pv-stage">
        <div className="pv-frame" style={{ width: marco.width }}>
          <AdeApp
            key={superficie} client={client} host={host} syncHash title="Lixbon ADE"
            ideContext={ideAbierto ? { path: WORKTREE_IDE } : undefined}
          />
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Preview />
  </React.StrictMode>,
);
