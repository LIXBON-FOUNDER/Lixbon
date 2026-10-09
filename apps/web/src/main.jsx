import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App, { precargarRuta } from './App.jsx';

import './styles/base.css';
import './styles/auth.css';
import './styles/chat.css';
import './styles/visuals.css';
import './styles/visual.css';
import './styles/account.css';
import './styles/admin.css';
import './styles/pagos.css';
import './styles/public.css';
import './styles/landing.css';
import './styles/web.css';
import './styles/remote.css';
import './styles/mascota.css';
import './styles/titulares.css';
// El último: solo añade movimiento a lo anterior (ver motion.css).
import './styles/motion.css';

precargarRuta(window.location.pathname).then(() => {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
