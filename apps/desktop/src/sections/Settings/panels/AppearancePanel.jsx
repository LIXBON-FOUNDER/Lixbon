// AppearancePanel.jsx — tema de la app y tamaño de letra del editor.
import { useAppStore } from '../../../store/appStore';
import { useTheme } from '../../../lib/theme';

export function AppearancePanel() {
  const { editorFontSize, setEditorFontSize } = useAppStore();
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

      <p className="settings__hint">
        Un tema de VSCode activo (panel de extensiones) tiene prioridad sobre
        este modo mientras esté aplicado.
      </p>

      <div className="settings__inline settings__inline--spread">
        <span className="settings__row-label">Tamaño de letra del editor</span>
        <span className="settings__slider">
          <input
            type="range"
            min="12"
            max="20"
            value={editorFontSize}
            onChange={(e) => setEditorFontSize(parseInt(e.target.value, 10))}
          />
          <span className="settings__slider-value">{editorFontSize}px</span>
        </span>
      </div>
    </section>
  );
}
