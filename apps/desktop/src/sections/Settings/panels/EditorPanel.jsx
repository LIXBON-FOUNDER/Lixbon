// EditorPanel.jsx — comportamiento del editor: guardado, formato e indentación.
import { useAppStore } from '../../../store/appStore';

export function EditorPanel() {
  const {
    autoSave, setAutoSave,
    formatOnSave, setFormatOnSave,
    tabSize, setTabSize,
    insertSpaces, setInsertSpaces,
  } = useAppStore();

  return (
    <>
      <section className="settings__panel">
        <h3 className="settings__panel-title">Guardado</h3>

        <div className="settings__inline settings__inline--spread">
          <span className="settings__row-label">
            Autoguardado
            <span className="settings__row-hint"> · guarda 1 s después de dejar de escribir</span>
          </span>
          <button
            className={`settings__toggle ${autoSave ? 'is-on' : ''}`}
            onClick={() => setAutoSave(!autoSave)}
            role="switch"
            aria-checked={autoSave}
          >
            <span className="settings__toggle-knob" />
          </button>
        </div>

        <div className="settings__inline settings__inline--spread">
          <span className="settings__row-label">
            Formatear al guardar
            <span className="settings__row-hint">
              {' · '}con Ctrl+S; requiere prettier / black / rustfmt / gofmt instalado
            </span>
          </span>
          <button
            className={`settings__toggle ${formatOnSave ? 'is-on' : ''}`}
            onClick={() => setFormatOnSave(!formatOnSave)}
            role="switch"
            aria-checked={formatOnSave}
          >
            <span className="settings__toggle-knob" />
          </button>
        </div>
      </section>

      <section className="settings__panel">
        <h3 className="settings__panel-title">Indentación</h3>

        <div className="settings__inline settings__inline--spread">
          <span className="settings__row-label">Tamaño del tabulador</span>
          <span className="settings__segmented">
            {[2, 4, 8].map((n) => (
              <button
                key={n}
                className={`settings__segment ${tabSize === n ? 'is-active' : ''}`}
                onClick={() => setTabSize(n)}
              >
                {n}
              </button>
            ))}
          </span>
        </div>

        <div className="settings__inline settings__inline--spread">
          <span className="settings__row-label">
            Insertar espacios al tabular
            <span className="settings__row-hint">
              {insertSpaces ? ' · se insertan espacios' : ' · se insertan tabulaciones'}
            </span>
          </span>
          <button
            className={`settings__toggle ${insertSpaces ? 'is-on' : ''}`}
            onClick={() => setInsertSpaces(!insertSpaces)}
            role="switch"
            aria-checked={insertSpaces}
          >
            <span className="settings__toggle-knob" />
          </button>
        </div>
      </section>
    </>
  );
}
