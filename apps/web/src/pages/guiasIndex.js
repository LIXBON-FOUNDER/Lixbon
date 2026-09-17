// guiasIndex.js — índice de las guías (sin JSX: lo lee el sitemap). id es el
// mismo en los dos idiomas; title/description sí cambian.
export const GUIAS_INDEX = [
  {
    id: 'openai-compatible-api',
    title: {
      es: 'API compatible con OpenAI: conecta lixbon a tu código en cinco minutos',
      en: 'OpenAI-compatible API: connect lixbon to your code in five minutes',
    },
    description: {
      es: 'Qué significa que una API sea compatible con OpenAI, cómo conseguir tu clave en lixbon, y ejemplos en cURL, Python y JavaScript con streaming y control de costos.',
      en: 'What it means for an API to be OpenAI-compatible, how to get your key in lixbon, and examples in cURL, Python and JavaScript with streaming and cost control.',
    },
    fecha: '2026-09-15', minutos: 6,
  },
  {
    id: 'qwen-3-5-python',
    title: {
      es: 'Cómo usar Qwen 3.5 desde Python con una API key',
      en: 'How to use Qwen 3.5 from Python with an API key',
    },
    description: {
      es: 'Paso a paso para llamar a Qwen 3.5 (Lixbon 1) desde Python: instalación del SDK, prompt de sistema, streaming, respuestas en JSON y cuánto cuesta cada llamada.',
      en: 'A step-by-step guide to calling Qwen 3.5 (Lixbon 1) from Python: installing the SDK, system prompt, streaming, JSON responses and how much each call costs.',
    },
    fecha: '2026-09-15', minutos: 7,
  },
  {
    id: 'cli-agent-mode',
    title: {
      es: 'Un agente de código en tu terminal: guía del modo agente del CLI',
      en: 'A coding agent in your terminal: a guide to the CLI’s agent mode',
    },
    description: {
      es: 'Instala el CLI de lixbon y deja que un agente lea tu proyecto, edite archivos, ejecute pruebas y haga commits, con aprobación paso a paso y modo plan.',
      en: 'Install the lixbon CLI and let an agent read your project, edit files, run tests and make commits, with step-by-step approval and plan mode.',
    },
    fecha: '2026-09-15', minutos: 8,
  },
  {
    id: 'private-data-own-gpus',
    title: {
      es: 'IA con tus datos en GPUs propias: qué cambia frente a ChatGPT',
      en: 'AI with your data on owned GPUs: what changes compared to ChatGPT',
    },
    description: {
      es: 'Dónde van tus conversaciones cuando usas un chat de IA, qué significa que los modelos corran en GPUs propias y qué controles tienes en lixbon sobre tu historial.',
      en: 'Where your conversations go when you use an AI chat, what it means for models to run on owned GPUs, and what controls lixbon gives you over your history.',
    },
    fecha: '2026-09-15', minutos: 6,
  },
];
