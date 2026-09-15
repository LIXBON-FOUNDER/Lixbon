// PublicFooter.jsx — pie común de las páginas públicas: enlaces legales y soporte.
import { Link } from 'react-router-dom';

export function PublicFooter() {
  return (
    <footer className="pubfoot">
      <span className="pubfoot__marca">© {new Date().getFullYear()} lixbon</span>
      <nav className="pubfoot__links" aria-label="Legal">
        <Link to="/legal/privacidad">Privacidad</Link>
        <Link to="/legal/terminos">Términos</Link>
        <Link to="/legal/reembolsos">Reembolsos</Link>
        <a href="mailto:soporte@lixbon.com">Soporte</a>
      </nav>
    </footer>
  );
}
