import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/jetbrains-mono';
import '../styles/base.css';
import '../styles/studio.css';
import './styles/core.css';
import OrchDesktop from './orch/OrchDesktop';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <OrchDesktop />
  </React.StrictMode>,
);
