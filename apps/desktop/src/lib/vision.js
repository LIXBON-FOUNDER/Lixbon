// vision.js — sub-agente de visión. Un modelo multimodal (llava, moondream,
// qwen2.5-vl…) DESCRIBE las imágenes adjuntas en texto para que el modelo
// principal de solo-texto (qwen3.5…) pueda razonar sobre ellas.

// Respaldo legacy: nombres de modelos de visión conocidos en Ollama. Solo se usa
// cuando el catálogo no trae `capabilities` (gateway o node_agent anterior a
// ellas). Adivinar por el nombre falla en ambos sentidos: hay multimodales que no
// lo dicen en el id y modelos con "vision" en el nombre que no lo son.
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

/** Primer modelo del catálogo que DECLARA `capability` (o '' si ninguno).
    Solo mira lo declarado: un modelo sin capabilities conocidas no cuenta aquí,
    porque para elegir hace falta una afirmación, no una ausencia de datos. */
export function detectByCapability(availableModels = [], capability) {
  for (const m of availableModels) {
    const caps = m?.capabilities;
    if (Array.isArray(caps) && caps.includes(capability)) {
      const id = modelId(m);
      if (id) return id;
    }
  }
  return '';
}

/** Elige un modelo de visión de la lista disponible (o '' si no hay).
    Prefiere la capacidad declarada; el patrón por nombre queda como respaldo. */
export function detectVisionModel(availableModels = []) {
  const porCapacidad = detectByCapability(availableModels, 'vision');
  if (porCapacidad) return porCapacidad;
  for (const m of availableModels) {
    // Si el catálogo declara capabilities y no incluyen `vision`, es un NO
    // fiable: no reincidir en el patrón por nombre (`gemma3` sin visión, etc.).
    if (Array.isArray(m?.capabilities) && m.capabilities.length) continue;
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
