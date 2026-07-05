import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './hooks/useAuth';

import ChatPage from './pages/ChatPage';
import AuthPage from './pages/AuthPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import AccountPage from './pages/AccountPage';
import PlansPage from './pages/PlansPage';
import AdminPage from './pages/AdminPage';
import DownloadsPage from './pages/DownloadsPage';
import DocsPage from './pages/DocsPage';

export default function App() {
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
          <Route path="/descargas" element={<DownloadsPage />} />
          <Route path="/docs" element={<DocsPage />} />
          <Route path="/docs/:section" element={<DocsPage />} />
          {/* Rutas legacy del dashboard viejo */}
          <Route path="/login" element={<Navigate to="/auth" replace />} />
          <Route path="/register" element={<Navigate to="/auth?mode=register" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
