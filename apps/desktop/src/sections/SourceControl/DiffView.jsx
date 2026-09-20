// DiffView.jsx — visor de diff unified (C1/C2). Colorea añadidos/eliminados y
// separa por archivo/hunk. Se abre dentro de la ventana flotante Modal
// (modalView 'diff', ver AppShell.jsx), que ya pone título y cierre.
import { useMemo } from 'react';
import { useAppStore } from '../../store/appStore';

/** Clasifica cada línea del patch para colorearla. */
function classify(line) {
  if (line.startsWith('diff --git') || line.startsWith('index ')) return 'meta';
  if (line.startsWith('+++') || line.startsWith('---')) return 'file';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

export function DiffView() {
  const diffData = useAppStore((s) => s.diffData);

  const lines = useMemo(() => {
    const text = diffData?.patch ?? '';
    if (!text.trim()) return [];
    return text.replace(/\r\n/g, '\n').split('\n').map((l) => ({ text: l, kind: classify(l) }));
  }, [diffData]);

  return (
    <div className="diffview">
      <div className="diffview__body">
        {lines.length === 0 ? (
          <p className="settings__hint" style={{ padding: '16px' }}>Sin diferencias.</p>
        ) : (
          <pre className="diffview__pre">
            {lines.map((l, i) => (
              <div key={i} className={`diffview__line diffview__line--${l.kind}`}>
                {l.text || ' '}
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}
