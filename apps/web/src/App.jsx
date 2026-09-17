import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import LandingPage from './pages/LandingPage';
import GuiasPage from './pages/GuiasPage';
import { AuthProvider } from './hooks/useAuth';
import { ConfirmarProvider } from './hooks/useConfirmar';
import { useViewportHeight } from './hooks/useViewportHeight';
import { RouteFade } from './components/RouteFade';
import { LocaleProvider } from './i18n/LocaleContext';

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
import AdminAlias from './pages/admin/Alias';
import VisualsPage from './pages/VisualsPage';
import AdminTarifas from './pages/admin/Tarifas';
import AdminProveedores from './pages/admin/Proveedores';
import AdminNodos from './pages/admin/Nodos';
import AdminIngresos from './pages/admin/Ingresos';
import AdminReleases from './pages/admin/Releases';
import AdminAuditoria from './pages/admin/Auditoria';
import AdminTransacciones from './pages/admin/Transacciones';
import AdminLiquidaciones from './pages/admin/Liquidaciones';
import AdminPasarela from './pages/admin/Pasarela';
import DownloadsPage from './pages/DownloadsPage';
import ReleasesPage from './pages/ReleasesPage';
import DocsPage from './pages/DocsPage';
import SharedPage from './pages/SharedPage';
import RemotePage from './pages/RemotePage';
import NotFoundPage from './pages/NotFoundPage';
import LegalPage from './pages/LegalPage';
import StatusPage from './pages/StatusPage';

// Árbol de rutas públicas y de app: se monta dos veces (ver AppRoutes), una
// vez en / (español, idioma por defecto) y otra en /en (inglés). El slug es
// el mismo en los dos idiomas — solo cambia si hay o no prefijo /en — así que
// el árbol no necesita saber en qué idioma está.
function LocalizedRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/chat" element={<ChatPage />} />
      <Route path="/guides" element={<GuiasPage />} />
      <Route path="/guides/:slug" element={<GuiasPage />} />
      <Route path="/c/:id" element={<ChatPage />} />
      <Route path="/visuals" element={<VisualsPage />} />
      <Route path="/visuals/:id" element={<VisualsPage />} />
      <Route path="/auth" element={<AuthPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/account" element={<AccountPage />} />
      <Route path="/account/:section" element={<AccountPage />} />
      <Route path="/plans" element={<PlansPage />} />
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<AdminInicio />} />
        <Route path="ia" element={<Navigate to="/admin/ia/modelos" replace />} />
        <Route path="ia/modelos" element={<AdminModelos />} />
        <Route path="ia/roles" element={<AdminRoles />} />
        <Route path="ia/alias" element={<AdminAlias />} />
        <Route path="ia/tarifas" element={<AdminTarifas />} />
        <Route path="proveedores" element={<AdminProveedores />} />
        <Route path="nodos" element={<AdminNodos />} />
        <Route path="ingresos" element={<AdminIngresos />} />
        <Route path="pagos" element={<Navigate to="/admin/pagos/transacciones" replace />} />
        <Route path="pagos/transacciones" element={<AdminTransacciones />} />
        <Route path="pagos/liquidaciones" element={<AdminLiquidaciones />} />
        <Route path="pagos/pasarela" element={<AdminPasarela />} />
        <Route path="usuarios" element={<AdminUsuarios />} />
        <Route path="releases" element={<AdminReleases />} />
        <Route path="auditoria" element={<AdminAuditoria />} />
      </Route>
      <Route path="/apps" element={<DownloadsPage />} />
      <Route path="/news" element={<ReleasesPage />} />
      <Route path="/status" element={<StatusPage />} />
      <Route path="/docs" element={<DocsPage />} />
      <Route path="/docs/:section" element={<DocsPage />} />
      <Route path="/legal" element={<Navigate to="/legal/privacy" replace />} />
      <Route path="/legal/:doc" element={<LegalPage />} />
      <Route path="/s/:token" element={<SharedPage />} />
      <Route path="/remote" element={<RemotePage />} />
      <Route path="/remote/:token" element={<RemotePage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

export function AppRoutes() {
  // El idioma se decide una vez aquí arriba, por la URL, y envuelve TODO
  // (incluido ConfirmarProvider: sus diálogos viven fuera del árbol de
  // <Routes>, así que si LocaleProvider estuviera solo ahí dentro los
  // confirmar() saldrían siempre en español).
  const { pathname } = useLocation();
  const locale = pathname === '/en' || pathname.startsWith('/en/') ? 'en' : 'es';

  return (
    <LocaleProvider locale={locale}>
      <AuthProvider>
        <ConfirmarProvider>
          <RouteFade>
            <Routes>
              {/* Rutas legacy: nombres antiguos en español, solo existieron sin
                  prefijo /en. */}
              <Route path="/planes" element={<Navigate to="/plans" replace />} />
              <Route path="/guias" element={<Navigate to="/guides" replace />} />
              <Route path="/aplicaciones" element={<Navigate to="/apps" replace />} />
              <Route path="/descargas" element={<Navigate to="/apps" replace />} />
              <Route path="/novedades" element={<Navigate to="/news" replace />} />
              <Route path="/login" element={<Navigate to="/auth" replace />} />
              <Route path="/register" element={<Navigate to="/auth?mode=register" replace />} />

              <Route path="/en/*" element={<LocalizedRoutes />} />
              <Route path="/*" element={<LocalizedRoutes />} />
            </Routes>
          </RouteFade>
        </ConfirmarProvider>
      </AuthProvider>
    </LocaleProvider>
  );
}

export default function App() {
  useViewportHeight(); // --app-vh: alto real del viewport (teclado móvil)
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
