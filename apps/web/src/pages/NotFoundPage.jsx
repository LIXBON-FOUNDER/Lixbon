// NotFoundPage.jsx — la ruta que no existe (comodín `*` en App.jsx).
// El 404 gigante es relleno, no texto: la jerarquía la hace la superficie.
import { Link, useLocation } from 'react-router-dom';
import { PublicNav } from '../components/PublicNav';
import { ClusterCaido } from '../components/ClusterCaido';

export default function NotFoundPage() {
  const { pathname } = useLocation();

  return (
    <div className="page notfound">
      <ClusterCaido />
      <PublicNav />

      <main className="notfound__body">
        <div className="notfound__numeral" aria-hidden="true">404</div>

        <div className="notfound__row">
          <div className="notfound__text">
            <h1 className="page__title">Esta página no existe</h1>
            <p className="notfound__lead">
              La dirección <code className="mono notfound__ruta">{pathname}</code> puede
              estar mal escrita, o la página se movió a otro sitio.
            </p>
          </div>

          <div className="notfound__actions">
            <Link to="/docs" className="pill-btn pill-btn--outline">Documentación</Link>
            <Link to="/" className="pill-btn pill-btn--primary">Ir al chat</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
