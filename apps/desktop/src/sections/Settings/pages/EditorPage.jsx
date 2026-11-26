// Ajustes → Editor: código y terminal. Tema y escala viven en Apariencia.
import { useWorkbenchStore } from '../../../store/workbenchStore';
import { useTerminalStore, SHELL_OPTIONS } from '../../../store/terminalStore';
import { Segmented } from '../../../components/Segmented';
import { Switch } from '../../../components/Switch';
import { Select } from '../../../components/Select';
import { IconCode } from '../../../components/Icons';
import { PageHead, SectionHead } from '../SettingsParts';

export function EditorPage() {
  const editor = useWorkbenchStore((s) => s.editor);
  const setOption = useWorkbenchStore((s) => s.setEditorOption);
  const { defaultShell, setDefaultShell } = useTerminalStore();

  return (
    <div className="spage">
      <PageHead icon={IconCode} title="Editor" sub="Cómo se ve el código y el terminal." />

      <section className="ssec rise rise--2">
        <SectionHead label="Editor" />
        <div className="ssec ssec--card ssec--rows">
          <div className="srow">
            <div className="srow__text">
              <span className="srow__label">Tamaño de fuente</span>
              <span className="srow__hint">Del código en el editor, entre 10 y 22 px.</span>
            </div>
            <span className="stepper">
              <button className="ic" onClick={() => setOption('fontSize', Math.max(10, editor.fontSize - 1))} aria-label="Reducir">−</button>
              <span className="mono stepper__value" key={editor.fontSize}>{editor.fontSize}</span>
              <button className="ic" onClick={() => setOption('fontSize', Math.min(22, editor.fontSize + 1))} aria-label="Aumentar">+</button>
            </span>
          </div>
          <div className="srow">
            <div className="srow__text">
              <span className="srow__label">Tamaño de tabulación</span>
              <span className="srow__hint">Espacios que ocupa cada nivel de sangría.</span>
            </div>
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

      <section className="ssec rise rise--3">
        <SectionHead label="Terminal" />
        <div className="ssec ssec--card ssec--rows">
          <div className="srow">
            <div className="srow__text">
              <span className="srow__label">Shell por defecto</span>
              <span className="srow__hint">La que se abre con el terminal y con el botón +.</span>
            </div>
            <Select value={defaultShell} onChange={setDefaultShell} options={SHELL_OPTIONS.map((s) => ({ value: s.id, label: s.label }))} />
          </div>
        </div>
      </section>
    </div>
  );
}
