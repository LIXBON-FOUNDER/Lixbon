import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './hooks/useAuth';
import { useViewportHeight } from './hooks/useViewportHeight';

import ChatPage from './pages/ChatPage';
import AuthPage from './pages/AuthPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import AccountPage from './pages/AccountPage';
import PlansPage from './pages/PlansPage';
import AdminPage from './pages/AdminPage';
import DownloadsPage from './pages/DownloadsPage';
import ReleasesPage from './pages/ReleasesPage';
import DocsPage from './pages/DocsPage';
import SharedPage from './pages/SharedPage';
import RemotePage from './pages/RemotePage';

export default function App() {
  useViewportHeight(); // --app-vh: alto real del viewport (teclado móvil)

  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<ChatPage />} />
          <Route path="/c/:id" element={<ChatPage />} />
          <Route path="/auth" element={<AuthPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/account/:section" element={<AccountPage />} />
          <Route path="/planes" element={<PlansPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/aplicaciones" element={<DownloadsPage />} />
          <Route path="/descargas" element={<Navigate to="/aplicaciones" replace />} />
          <Route path="/novedades" element={<ReleasesPage />} />
          <Route path="/docs" element={<DocsPage />} />
          <Route path="/docs/:section" element={<DocsPage />} />
          <Route path="/s/:token" element={<SharedPage />} />
          <Route path="/remote" element={<RemotePage />} />
          <Route path="/remote/:token" element={<RemotePage />} />
          {/* Rutas legacy del dashboard viejo */}
          <Route path="/login" element={<Navigate to="/auth" replace />} />
          <Route path="/register" element={<Navigate to="/auth?mode=register" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
