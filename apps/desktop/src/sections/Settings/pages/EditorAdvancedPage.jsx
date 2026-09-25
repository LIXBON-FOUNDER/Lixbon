// EditorAdvancedPage.jsx — Ajustes → Editor y avanzado: editor, terminal,
// índice del código, servidor y actualizaciones.
import { useWorkbenchStore } from '../../../store/workbenchStore';
import { useTerminalStore, SHELL_OPTIONS } from '../../../store/terminalStore';
import { Segmented } from '../../../components/Segmented';
import { Switch } from '../../../components/Switch';
import { Select } from '../../../components/Select';
import { IndexPanel } from '../panels/IndexPanel';
import { AdvancedPanel } from '../panels/AdvancedPanel';

export function EditorAdvancedPage() {
  const editor = useWorkbenchStore((s) => s.editor);
  const setOption = useWorkbenchStore((s) => s.setEditorOption);
  const { defaultShell, setDefaultShell } = useTerminalStore();

  return (
    <div className="spage">
      <div className="spage__head rise">
        <div className="spage__title">
          <span className="spage__h1">Editor y avanzado</span>
          <span className="spage__sub">Cómo se ve el código, el terminal y la conexión con el clúster.</span>
        </div>
      </div>

      <section className="ssec rise rise--1">
        <span className="ssec__label">Editor</span>
        <div className="ssec ssec--card ssec--rows">
          <div className="srow">
            <span className="srow__label">Tamaño de fuente</span>
            <span className="stepper">
              <button className="ic" onClick={() => setOption('fontSize', Math.max(10, editor.fontSize - 1))} aria-label="Reducir">−</button>
              <span className="mono stepper__value" key={editor.fontSize}>{editor.fontSize}</span>
              <button className="ic" onClick={() => setOption('fontSize', Math.min(22, editor.fontSize + 1))} aria-label="Aumentar">+</button>
            </span>
          </div>
          <div className="srow">
            <span className="srow__label">Tamaño de tabulación</span>
            <Segmented size="sm" width={44} value={editor.tabSize} onChange={(v) => setOption('tabSize', v)} options={[2, 4, 8].map((n) => ({ value: n, label: String(n) }))} />
          </div>
          <div className="srow">
            <div className="srow__text">
              <span className="srow__label">Ajuste de línea</span>
              <span className="srow__hint">Las líneas largas se parten en el ancho visible.</span>
            </div>
            <Switch checked={editor.wordWrap} onChange={(v) => setOption('wordWrap', v)} label="Ajuste de línea" />
          </div>
        </div>
      </section>

      <section className="ssec rise rise--2">
        <span className="ssec__label">Terminal</span>
        <div className="ssec ssec--card">
          <div className="srow">
            <div className="srow__text">
              <span className="srow__label">Shell por defecto</span>
              <span className="srow__hint">La que se abre con el terminal y con el botón +.</span>
            </div>
            <Select value={defaultShell} onChange={setDefaultShell} options={SHELL_OPTIONS.map((s) => ({ value: s.id, label: s.label }))} />
          </div>
        </div>
      </section>

      <section className="ssec rise rise--3">
        <span className="ssec__label">Índice del código</span>
        <div className="legacyset"><IndexPanel /></div>
      </section>

      <section className="ssec rise rise--3">
        <span className="ssec__label">Servidor y actualizaciones</span>
        <div className="legacyset"><AdvancedPanel /></div>
      </section>
    </div>
  );
}
