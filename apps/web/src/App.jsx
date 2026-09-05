import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './hooks/useAuth';
import { useViewportHeight } from './hooks/useViewportHeight';
import { RouteFade } from './components/RouteFade';

import ChatPage from './pages/ChatPage';
import AuthPage from './pages/AuthPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import AccountPage from './pages/AccountPage';
import PlansPage from './pages/PlansPage';
import AdminLayout from './pages/admin/AdminLayout';
import AdminInicio from './pages/admin/Inicio';
import AdminUsuarios from './pages/admin/Usuarios';
import AdminModelos from './pages/admin/Modelos';
import AdminRoles from './pages/admin/Roles';
import AdminTarifas from './pages/admin/Tarifas';
import AdminProveedores from './pages/admin/Proveedores';
import AdminNodos from './pages/admin/Nodos';
import AdminIngresos from './pages/admin/Ingresos';
import AdminReleases from './pages/admin/Releases';
import AdminAuditoria from './pages/admin/Auditoria';
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
        <RouteFade>
          <Routes>
            <Route path="/" element={<ChatPage />} />
            <Route path="/c/:id" element={<ChatPage />} />
            <Route path="/auth" element={<AuthPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/account" element={<AccountPage />} />
            <Route path="/account/:section" element={<AccountPage />} />
            <Route path="/planes" element={<PlansPage />} />
            <Route path="/admin" element={<AdminLayout />}>
              <Route index element={<AdminInicio />} />
              <Route path="ia" element={<Navigate to="/admin/ia/modelos" replace />} />
              <Route path="ia/modelos" element={<AdminModelos />} />
              <Route path="ia/roles" element={<AdminRoles />} />
              <Route path="ia/tarifas" element={<AdminTarifas />} />
              <Route path="proveedores" element={<AdminProveedores />} />
              <Route path="nodos" element={<AdminNodos />} />
              <Route path="ingresos" element={<AdminIngresos />} />
              <Route path="usuarios" element={<AdminUsuarios />} />
              <Route path="releases" element={<AdminReleases />} />
              <Route path="auditoria" element={<AdminAuditoria />} />
            </Route>
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
        </RouteFade>
      </AuthProvider>
    </BrowserRouter>
  );
}
