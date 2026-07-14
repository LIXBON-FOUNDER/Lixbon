// LanguagePanel.jsx — servidores de lenguaje (LSP): estado e instalación.
//
// Aquí vive la inteligencia de código que la gente busca en las extensiones de
// VSCode: la extensión de Python es un envoltorio de Pyright, la de Rust de
// rust-analyzer. Hablamos LSP directamente con esos servidores.
import { useEffect } from 'react';
import { useLspStore } from '../../../store/lspStore';
import { ALL_SERVERS } from '../../../lib/lspServers';

const STATE_LABEL = {
  ready: 'activo',
  starting: 'arrancando…',
  installing: 'instalando…',
  installed: 'instalado',
  missing: 'no instalado',
  failed: 'error',
};

function ServerRow({ server }) {
  const info = useLspStore((s) => s.servers[server.id]) || {};
  const installServer = useLspStore((s) => s.installServer);
  const reinstallServer = useLspStore((s) => s.reinstallServer);

  const state = info.state || 'missing';
  const busy = state === 'installing' || state === 'starting';
  const present = state === 'installed' || state === 'ready';

  return (
    <div className="lsp__row">
      <span className="lsp__name">
        {server.label}
        <span className={`lsp__state lsp__state--${state}`}>{STATE_LABEL[state]}</span>
      </span>

      <span className="lsp__action">
        {info.error && <span className="lsp__error">{info.error}</span>}

        {server.install ? (
          <button
            className="settings__btn"
            disabled={busy}
            onClick={() => (present ? reinstallServer(server) : installServer(server))}
          >
            {busy ? 'Instalando…' : present ? 'Reinstalar' : 'Instalar'}
          </button>
        ) : (
          // Sin receta automática: necesita su toolchain (Go, LLVM…).
          <code className="lsp__manual">{server.manual}</code>
        )}
      </span>
    </div>
  );
}

export function LanguagePanel() {
  const { enabled, setEnabled, autoInstall, setAutoInstall, refreshServers } = useLspStore();

  useEffect(() => { refreshServers(); }, [refreshServers]);

  return (
    <>
      <section className="settings__panel">
        <h3 className="settings__panel-title">Servidores de lenguaje (LSP)</h3>

        <div className="settings__inline settings__inline--spread">
          <span className="settings__row-label">
            Activar LSP
            <span className="settings__row-hint">
              {' · '}autocompletado real, errores en vivo, hover e ir a definición (F12)
            </span>
          </span>
          <button
            className={`settings__toggle ${enabled ? 'is-on' : ''}`}
            onClick={() => setEnabled(!enabled)}
            role="switch"
            aria-checked={enabled}
          >
            <span className="settings__toggle-knob" />
          </button>
        </div>

        <div className="settings__inline settings__inline--spread">
          <span className="settings__row-label">
            Instalar servidores automáticamente
            <span className="settings__row-hint">
              {' · '}al abrir el primer archivo de un lenguaje, si falta su servidor se descarga solo
            </span>
          </span>
          <button
            className={`settings__toggle ${autoInstall ? 'is-on' : ''}`}
            onClick={() => setAutoInstall(!autoInstall)}
            role="switch"
            aria-checked={autoInstall}
          >
            <span className="settings__toggle-knob" />
          </button>
        </div>

        <p className="settings__hint">
          Se instalan dentro de lixbon (no son globales: ni piden permisos de
          administrador ni tocan tu PATH). Si ya tienes uno instalado por tu
          cuenta, ese tiene prioridad. Con un servidor activo, él sustituye a
          ruff/eslint como fuente de los problemas.
        </p>
      </section>

      <section className="settings__panel">
        <h3 className="settings__panel-title">Servidores</h3>
        <p className="settings__hint">
          Los que se instalan con npm necesitan <strong>Node.js</strong> en el
          sistema. Go y C/C++ necesitan su propia toolchain, así que esos hay que
          instalarlos a mano.
        </p>

        <div className="lsp__list">
          {ALL_SERVERS.map((s) => (
            <ServerRow key={s.id} server={s} />
          ))}
        </div>
      </section>
    </>
  );
}
