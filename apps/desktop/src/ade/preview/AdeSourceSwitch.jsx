// AdeSourceSwitch.jsx — elige qué alimenta Orquestar: el Core real o la vista previa con datos simulados.
// No aparece si la vista previa no está disponible (binario sin activarla en Ajustes).
import { Segmented } from '../../components/Segmented';
import { usePreviewSource } from './previewSource';

export function AdeSourceSwitch() {
  const available = usePreviewSource((s) => s.available);
  const source = usePreviewSource((s) => s.source);
  const setSource = usePreviewSource((s) => s.setSource);
  if (!available) return null;
  return (
    <Segmented
      size="sm"
      width={74}
      value={source}
      onChange={setSource}
      className="pv-source"
      options={[
        { value: 'core', label: 'Core', title: 'Datos reales del Core' },
        { value: 'preview', label: 'Vista previa', title: 'Maqueta con datos simulados: lo que el Core aún no da' },
      ]}
    />
  );
}
