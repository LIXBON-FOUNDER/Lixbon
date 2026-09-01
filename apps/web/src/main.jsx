import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

import './styles/base.css';
import './styles/auth.css';
import './styles/chat.css';
import './styles/account.css';
import './styles/admin.css';
import './styles/public.css';
import './styles/remote.css';
// El último: solo añade movimiento a lo anterior (ver motion.css).
import './styles/motion.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
