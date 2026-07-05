// ModelPicker.jsx — selector de modelo (lista de GET /v1/models).
import { useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import { api } from '../lib/api';

export function ModelPicker() {
  const { currentModel, setCurrentModel, availableModels, setAvailableModels, connectionStatus } = useAppStore();

  useEffect(() => {
    if (connectionStatus !== 'connected' || availableModels.length > 0) return;
    let cancelled = false;
    api.get('/v1/models')
      .then((res) => {
        if (cancelled || !res?.data) return;
        setAvailableModels(res.data);
        const ids = res.data.map((m) => m.id);
        if (ids.length && !ids.includes(currentModel)) setCurrentModel(ids[0]);
      })
      .catch((e) => console.error('[models] Error cargando modelos:', e));
    return () => { cancelled = true; };
  }, [connectionStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  if (availableModels.length === 0) {
    return <span className="modelpicker modelpicker--empty">Sin modelos</span>;
  }

  return (
    <select
      className="modelpicker"
      value={currentModel}
      onChange={(e) => setCurrentModel(e.target.value)}
      title="Modelo activo"
    >
      {availableModels.map((m) => (
        <option key={m.id} value={m.id}>{m.id}</option>
      ))}
    </select>
  );
}
