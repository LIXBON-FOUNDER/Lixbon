// vision.js — utilidades del catálogo de modelos. (El nombre es histórico: aquí
// vivía el sub-agente de visión; ahora las imágenes van directas al modelo del
// chat, que es multimodal.)

/** Id (string) de un modelo. `availableModels` puede traer objetos {id,…}
    (formato /v1/models) o strings; esta función normaliza a string. */
export function modelId(m) {
  if (typeof m === 'string') return m;
  return (m && (m.id || m.name)) || '';
}
