import { Suspense, useRef } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import LandingPage from './pages/LandingPage';
import NotFoundPage from './pages/NotFoundPage';
import { AuthProvider } from './hooks/useAuth';
import { ConfirmarProvider } from './hooks/useConfirmar';
import { useViewportHeight } from './hooks/useViewportHeight';
import { RouteFade } from './components/RouteFade';
import { ScrollArriba } from './components/ScrollArriba';
import { LocaleProvider } from './i18n/LocaleContext';
import { idiomaGuardado, localeDePath, sinPrefijoLegacyEn, withLocale } from './i18n/paths';
import { MascotaSync } from './components/Mascota';
import { perezosa } from './lib/perezosa';

const GuiasPage = perezosa(() => import('./pages/GuiasPage'));
const ChatPage = perezosa(() => import('./pages/ChatPage'));
const AuthPage = perezosa(() => import('./pages/AuthPage'));
const ResetPasswordPage = perezosa(() => import('./pages/ResetPasswordPage'));
const AccountPage = perezosa(() => import('./pages/AccountPage'));
const PlansPage = perezosa(() => import('./pages/PlansPage'));
const VisualsPage = perezosa(() => import('./pages/VisualsPage'));
const SharedVisualPage = perezosa(() => import('./pages/SharedVisualPage'));
const DownloadsPage = perezosa(() => import('./pages/DownloadsPage'));
const ReleasesPage = perezosa(() => import('./pages/ReleasesPage'));
const DocsPage = perezosa(() => import('./pages/DocsPage'));
const SharedPage = perezosa(() => import('./pages/SharedPage'));
const RemotePage = perezosa(() => import('./pages/RemotePage'));
const LegalPage = perezosa(() => import('./pages/LegalPage'));
const StatusPage = perezosa(() => import('./pages/StatusPage'));
const SupportPage = perezosa(() => import('./pages/SupportPage'));
const CompanyPage = perezosa(() => import('./pages/CompanyPage'));
const LeadershipPage = perezosa(() => import('./pages/LeadershipPage'));
const SkillsPage = perezosa(() => import('./pages/SkillsPage'));

const admin = () => import('./pages/admin');
const AdminLayout = perezosa(admin, 'AdminLayout');
const AdminInicio = perezosa(admin, 'AdminInicio');
const AdminUsuarios = perezosa(admin, 'AdminUsuarios');
const AdminModelos = perezosa(admin, 'AdminModelos');
const AdminRoles = perezosa(admin, 'AdminRoles');
const AdminAlias = perezosa(admin, 'AdminAlias');
const AdminTarifas = perezosa(admin, 'AdminTarifas');
const AdminProveedores = perezosa(admin, 'AdminProveedores');
const AdminNodos = perezosa(admin, 'AdminNodos');
const AdminIngresos = perezosa(admin, 'AdminIngresos');
const AdminReleases = perezosa(admin, 'AdminReleases');
const AdminAuditoria = perezosa(admin, 'AdminAuditoria');
const AdminTransacciones = perezosa(admin, 'AdminTransacciones');
const AdminLiquidaciones = perezosa(admin, 'AdminLiquidaciones');
const AdminPasarela = perezosa(admin, 'AdminPasarela');
const AdminSkills = perezosa(admin, 'AdminSkills');
const AdminCorreos = perezosa(admin, 'AdminCorreos');
const ADMIN = [AdminLayout, AdminInicio, AdminUsuarios, AdminModelos, AdminRoles, AdminAlias, AdminTarifas, AdminProveedores, AdminNodos, AdminIngresos, AdminReleases, AdminAuditoria, AdminTransacciones, AdminLiquidaciones, AdminPasarela, AdminSkills, AdminCorreos];

const POR_SECCION = {
  chat: [ChatPage], c: [ChatPage], guides: [GuiasPage], visuals: [VisualsPage], auth: [AuthPage],
  'reset-password': [ResetPasswordPage], account: [AccountPage], plans: [PlansPage], admin: ADMIN,
  skills: [SkillsPage], apps: [DownloadsPage], news: [ReleasesPage], status: [StatusPage],
  support: [SupportPage], about: [CompanyPage], team: [LeadershipPage], docs: [DocsPage],
  legal: [LegalPage], remote: [RemotePage], s: [SharedPage, SharedVisualPage],
};

// La página de la URL de entrada se carga antes de montar para pintar sin hueco
// sobre el HTML prerenderizado.
export function precargarRuta(pathname) {
  const partes = pathname.split('/').filter(Boolean);
  if (partes[0] === 'es') partes.shift();
  return Promise.all((POR_SECCION[partes[0]] || []).map((p) => p.cargar())).catch(() => {});
}

export function precargarTodo() {
  return Promise.all(Object.values(POR_SECCION).flat().map((p) => p.cargar()));
}

// Se monta en / (inglés) y en /es: el slug es el mismo en los dos idiomas.
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
      <Route path="/s/v/:token" element={<SharedVisualPage />} />
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
        <Route path="skills" element={<AdminSkills />} />
        <Route path="correos" element={<AdminCorreos />} />
        <Route path="auditoria" element={<AdminAuditoria />} />
      </Route>
      <Route path="/skills" element={<SkillsPage />} />
      <Route path="/skills/:slug" element={<SkillsPage />} />
      <Route path="/apps" element={<DownloadsPage />} />
      <Route path="/news" element={<ReleasesPage />} />
      <Route path="/status" element={<StatusPage />} />
      <Route path="/support" element={<SupportPage />} />
      <Route path="/about" element={<CompanyPage />} />
      <Route path="/team" element={<LeadershipPage />} />
      <Route path="/company" element={<Navigate to="/about" replace />} />
      <Route path="/company/leadership" element={<Navigate to="/team" replace />} />
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
  const { pathname, search, hash } = useLocation();
  const locale = localeDePath(pathname);

  // La web arranca en inglés; solo se abre en español si el usuario lo eligió.
  // Se mira una vez, al entrar, para no pelear con los enlaces sin prefijo.
  const primeraVisita = useRef(true);
  let destino = sinPrefijoLegacyEn(pathname);
  if (primeraVisita.current) {
    primeraVisita.current = false;
    const base = destino ?? pathname;
    if (localeDePath(base) === 'en' && idiomaGuardado() === 'es') destino = withLocale(base, 'es');
  }
  if (destino !== null) return <Navigate to={`${destino}${search}${hash}`} replace />;

  return (
    <LocaleProvider locale={locale}>
      <AuthProvider>
        <MascotaSync />
        <ScrollArriba />
        <ConfirmarProvider>
          <RouteFade>
            <Suspense fallback={null}>
              <Routes>
                <Route path="/planes" element={<Navigate to="/es/plans" replace />} />
                <Route path="/guias" element={<Navigate to="/es/guides" replace />} />
                <Route path="/aplicaciones" element={<Navigate to="/es/apps" replace />} />
                <Route path="/descargas" element={<Navigate to="/es/apps" replace />} />
                <Route path="/novedades" element={<Navigate to="/es/news" replace />} />
                <Route path="/soporte" element={<Navigate to="/es/support" replace />} />
                <Route path="/login" element={<Navigate to="/auth" replace />} />
                <Route path="/register" element={<Navigate to="/auth?mode=register" replace />} />

                <Route path="/es/*" element={<LocalizedRoutes />} />
                <Route path="/*" element={<LocalizedRoutes />} />
              </Routes>
            </Suspense>
          </RouteFade>
        </ConfirmarProvider>
      </AuthProvider>
    </LocaleProvider>
  );
}

export default function App() {
  useViewportHeight();
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
