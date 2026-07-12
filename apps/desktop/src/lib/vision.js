// vision.js — sub-agente de visión. Un modelo multimodal (llava, moondream,
// qwen2.5-vl…) DESCRIBE las imágenes adjuntas en texto para que el modelo
// principal de solo-texto (qwen3.5…) pueda razonar sobre ellas.

// Patrones de nombres de modelos de visión conocidos en Ollama.
const VISION_PATTERNS = [
  'llava', 'bakllava', 'moondream', 'minicpm-v', 'llama3.2-vision', 'llama-3.2-vision',
  'qwen2-vl', 'qwen2.5-vl', 'qwen2.5vl', 'qwenvl', 'vision', 'gemma3', 'granite3.2-vision',
];

/** Id (string) de un modelo. `availableModels` puede traer objetos {id,…}
    (formato /v1/models) o strings; esta función normaliza a string. */
export function modelId(m) {
  if (typeof m === 'string') return m;
  return (m && (m.id || m.name)) || '';
}

/** Elige un modelo de visión de la lista disponible (o '' si no hay). */
export function detectVisionModel(availableModels = []) {
  for (const m of availableModels) {
    const id = modelId(m);
    if (id && VISION_PATTERNS.some((p) => id.toLowerCase().includes(p))) return id;
  }
  return '';
}

/** Llama al sub-agente de visión y devuelve la descripción en texto. */
export async function describeImages({ serverUrl, apiKey, model, images, prompt, signal }) {
  const res = await fetch(`${serverUrl}/api/vision/describe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, images, prompt: prompt || null }),
    signal,
  });
  if (!res.ok) {
    let detail = `El modelo de visión falló (${res.status})`;
    try {
      const body = await res.json();
      if (typeof body.detail === 'string') detail = body.detail;
      else if (body.detail?.message) detail = body.detail.message;
    } catch { /* cuerpo no-JSON */ }
    throw new Error(detail);
  }
  const data = await res.json();
  return (data.description || '').trim();
}
