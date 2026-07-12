// ErrorBoundary.jsx — evita la "pantalla en blanco": si algún componente lanza
// un error al renderizar, muestra el mensaje y el stack en pantalla (útil en
// builds de release donde no siempre hay devtools) con un botón para recargar.
import { Component } from 'react';

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    // También al log por si hay devtools/consola disponibles
    console.error('[Lixbon] Error de UI no capturado:', error, info);
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="errboundary">
        <div className="errboundary__card">
          <h1>Algo se rompió en la interfaz</h1>
          <p className="errboundary__hint">
            Copia este error y compártelo para arreglarlo. Luego pulsa Recargar.
          </p>
          <pre className="errboundary__msg">{String(error?.message || error)}</pre>
          {(error?.stack || info?.componentStack) && (
            <pre className="errboundary__stack">
              {error?.stack || ''}
              {info?.componentStack || ''}
            </pre>
          )}
          <div className="errboundary__actions">
            <button onClick={() => window.location.reload()}>Recargar</button>
            <button
              onClick={() => navigator.clipboard?.writeText(
                `${error?.message || error}\n\n${error?.stack || ''}\n${info?.componentStack || ''}`,
              )}
            >
              Copiar error
            </button>
          </div>
        </div>
      </div>
    );
  }
}
