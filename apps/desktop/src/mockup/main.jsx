// main.jsx — entrada AISLADA de la maqueta unificada (mockup.html). No monta App ni los stores de producción.
import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/jetbrains-mono';
import '../styles/base.css';
import '../styles/studio.css';
import './styles/core.css';
import './styles/ade.css';
import './styles/ide.css';
import './styles/mobile.css';
import './styles/cli.css';
import './styles/show.css';
import './styles/hierarchy.css';
import './styles/polish.css';
import './styles/layout.css';
import Showcase from './Showcase';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Showcase />
  </React.StrictMode>,
);
