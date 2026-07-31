// ModelPicker.jsx — selector de modelo. Carga el catálogo y el mapa rol→modelo.
import { useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import { api } from '../lib/api';
import { fetchModelRoles, roleModel } from '../lib/modelRoles';

export function ModelPicker() {
  const {
    currentModel, setCurrentModel, availableModels, setAvailableModels,
    setModelRoles, connectionStatus,
  } = useAppStore();

  useEffect(() => {
    if (connectionStatus !== 'connected' || availableModels.length > 0) return;
    let cancelled = false;
    // Un solo sitio carga ambas cosas: /api/model-roles ya incluye el catálogo,
    // así que con gateway nuevo no hay round-trip extra y /v1/models solo se
    // pide como respaldo (gateway antiguo sin el endpoint de roles).
    (async () => {
      const roles = await fetchModelRoles();
      if (cancelled) return;
      let catalogo = roles?.models;
      if (roles) setModelRoles(roles);
      if (!Array.isArray(catalogo) || catalogo.length === 0) {
        const res = await api.get('/v1/models').catch((e) => {
          console.error('[models] Error cargando modelos:', e);
          return null;
        });
        if (cancelled) return;
        catalogo = res?.data;
      }
      if (!Array.isArray(catalogo) || catalogo.length === 0) return;
      setAvailableModels(catalogo);
      const ids = catalogo.map((m) => m.id);
      if (!ids.includes(currentModel)) {
        // Preferir el modelo del rol `chat`: una instalación nueva debe arrancar
        // en el modelo de chat configurado, no en el primero que liste Ollama
        // (que puede ser el de visión o el de embeddings).
        const delRol = roleModel(roles, 'chat');
        setCurrentModel(ids.includes(delRol) ? delRol : ids[0]);
      }
    })();
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
