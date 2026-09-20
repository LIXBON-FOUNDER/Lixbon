// AppearancePanel.jsx — tema de la app.
import { useTheme } from '../../../lib/theme';

export function AppearancePanel() {
  const [theme, setThemeMode] = useTheme();

  return (
    <section className="settings__panel">
      <h3 className="settings__panel-title">Apariencia</h3>

      <div className="settings__inline settings__inline--spread">
        <span className="settings__row-label">Tema de la aplicación</span>
        <span className="settings__segmented">
          {[['light', 'Claro'], ['dark', 'Oscuro']].map(([mode, label]) => (
            <button
              key={mode}
              className={`settings__segment ${theme === mode ? 'is-active' : ''}`}
              onClick={() => setThemeMode(mode)}
            >
              {label}
            </button>
          ))}
        </span>
      </div>
    </section>
  );
}
