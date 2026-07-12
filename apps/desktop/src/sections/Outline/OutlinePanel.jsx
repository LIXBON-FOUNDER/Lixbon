// OutlinePanel.jsx — esquema de símbolos del archivo activo (A3). Extracción por
// regex (lib/outline). Clic en un símbolo salta a su línea.
import { useEffect, useState, useCallback } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { extractSymbols, hasOutline } from '../../lib/outline';
import { IconRefresh } from '../../components/Icons';

const KIND_ABBR = {
  class: 'C', function: 'ƒ', method: 'm', struct: 'S', enum: 'E', trait: 'T', impl: 'I',
};

export function OutlinePanel() {
  const activePath = useEditorStore((s) => s.activePath);
  const [symbols, setSymbols] = useState([]);
  const [name, setName] = useState('');

  const refresh = useCallback(() => {
    const ctx = useEditorStore.getState().getActiveContext();
    if (!ctx) { setSymbols([]); setName(''); return; }
    setName(ctx.name);
    setSymbols(extractSymbols(ctx.name, ctx.content));
  }, []);

  useEffect(() => { refresh(); }, [activePath, refresh]);

  const jump = (sym) => {
    useEditorStore.getState().openFileAtLine(activePath, name, sym.line);
  };

  return (
    <div className="outline">
      <div className="scm__head">
        <span className="scm__title">Esquema</span>
        <button className="icon-btn" onClick={refresh} title="Actualizar">
          <IconRefresh size={15} />
        </button>
      </div>
      {!activePath ? (
        <p className="settings__hint">Abre un archivo para ver su esquema.</p>
      ) : !hasOutline(name) ? (
        <p className="settings__hint">Sin esquema para este tipo de archivo.</p>
      ) : symbols.length === 0 ? (
        <p className="settings__hint">No se encontraron símbolos.</p>
      ) : (
        <div className="outline__list">
          {symbols.map((s, i) => (
            <button key={`${s.line}:${s.name}:${i}`} className="outline__item" onClick={() => jump(s)}>
              <span className={`outline__kind outline__kind--${s.kind}`}>{KIND_ABBR[s.kind] || '•'}</span>
              <span className="outline__name">{s.name}</span>
              <span className="outline__line">{s.line}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
