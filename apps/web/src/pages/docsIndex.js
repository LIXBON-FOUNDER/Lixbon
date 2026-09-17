// docsIndex.js — índice de las docs sin JSX: lo comparten la página de docs
// (menú, título y descripción de cada sección) y el sitemap que genera Vite.
// id es el slug de la URL (/docs/:id) y es el mismo en los dos idiomas; group,
// title y description sí cambian por idioma.
export const DOCS_INDEX = [
  { id: 'introduction', group: { es: 'Empezar', en: 'Get started' },
    title: { es: 'Introducción', en: 'Introduction' },
    description: {
      es: 'Qué es lixbon: chat con modelos de IA sobre GPUs propias, desde la web, el CLI, la app de escritorio, Visuals o la API.',
      en: 'What lixbon is: chat with AI models on our own GPUs, from the web, the CLI, the desktop app, Visuals or the API.',
    } },
  { id: 'getting-started', group: { es: 'Empezar', en: 'Get started' },
    title: { es: 'Primeros pasos', en: 'Getting started' },
    description: {
      es: 'Crea tu cuenta, envía tu primer mensaje, elige modelo y lleva lixbon a tu terminal o a tu editor.',
      en: 'Create your account, send your first message, pick a model, and bring lixbon to your terminal or editor.',
    } },
  { id: 'chat', group: { es: 'Aplicaciones', en: 'Apps' },
    title: { es: 'Chat web', en: 'Web chat' },
    description: {
      es: 'Cómo funciona el chat de lixbon: modelos, razonamiento, adjuntos, dictado, búsqueda web, historial y enlaces públicos.',
      en: 'How lixbon chat works: models, reasoning, attachments, dictation, web search, history and public links.',
    } },
  { id: 'visuals', group: { es: 'Aplicaciones', en: 'Apps' },
    title: { es: 'Visuals', en: 'Visuals' },
    description: {
      es: 'Diseña landings, dashboards, emails, logos y prototipos con IA; edítalos en el lienzo, compártelos y conviértelos en proyecto.',
      en: 'Design landing pages, dashboards, emails, logos and prototypes with AI; edit them on the canvas, share them and turn them into a project.',
    } },
  { id: 'cli', group: { es: 'Aplicaciones', en: 'Apps' },
    title: { es: 'CLI', en: 'CLI' },
    description: {
      es: 'Instala el CLI de lixbon en Windows, Linux o macOS: chat en la terminal, modo agente, modo plan y todos los comandos.',
      en: 'Install the lixbon CLI on Windows, Linux or macOS: terminal chat, agent mode, plan mode and every command.',
    } },
  { id: 'desktop', group: { es: 'Aplicaciones', en: 'Apps' },
    title: { es: 'App de escritorio', en: 'Desktop app' },
    description: {
      es: 'El IDE de lixbon: editor con autocompletado, chat y agente integrados, actualizaciones automáticas y canales estable y beta.',
      en: 'The lixbon IDE: an editor with built-in autocomplete, chat and agent, automatic updates, and stable and beta channels.',
    } },
  { id: 'remote', group: { es: 'Aplicaciones', en: 'Apps' },
    title: { es: 'Remote', en: 'Remote' },
    description: {
      es: 'Controla una sesión del CLI o del IDE desde el móvil o la web: transcript en vivo, nuevos prompts y aprobaciones.',
      en: 'Control a CLI or IDE session from your phone or the web: live transcript, new prompts and approvals.',
    } },
  { id: 'api', group: { es: 'Desarrolladores', en: 'Developers' },
    title: { es: 'API', en: 'API' },
    description: {
      es: 'API compatible con OpenAI: autenticación con API key, endpoint base, modelos y chat completions en streaming.',
      en: 'OpenAI-compatible API: API key authentication, base endpoint, models and streaming chat completions.',
    } },
  { id: 'using-your-api-key', group: { es: 'Desarrolladores', en: 'Developers' },
    title: { es: 'Usar tu API key', en: 'Using your API key' },
    description: {
      es: 'Recetas para usar tu API key de lixbon con cURL, los SDK de OpenAI en Python y JavaScript, continue.dev y otras herramientas.',
      en: 'Recipes for using your lixbon API key with cURL, the OpenAI SDKs for Python and JavaScript, continue.dev and other tools.',
    } },
  { id: 'api-pricing', group: { es: 'Desarrolladores', en: 'Developers' },
    title: { es: 'Precios de la API', en: 'API pricing' },
    description: {
      es: 'Tarifas por millón de tokens de cada modelo, cómo se calcula el costo y cómo funcionan los créditos prepago.',
      en: 'Per-million-token rates for each model, how cost is calculated, and how prepaid credits work.',
    } },
  { id: 'plans', group: { es: 'Cuenta y pagos', en: 'Account and billing' },
    title: { es: 'Planes y límites', en: 'Plans and limits' },
    description: {
      es: 'Gratuito, Pro y Advance: mensajes al día, tokens al mes, API keys, peticiones por minuto y cómo se cuentan los límites.',
      en: 'Free, Pro and Advance: messages per day, tokens per month, API keys, requests per minute, and how limits are counted.',
    } },
  { id: 'billing', group: { es: 'Cuenta y pagos', en: 'Account and billing' },
    title: { es: 'Facturación y pagos', en: 'Billing and payments' },
    description: {
      es: 'Cómo se cobra en lixbon: suscripción con tarjeta, cambio de plan prorrateado, cancelación, facturas, recargas y recarga automática.',
      en: 'How billing works in lixbon: card subscriptions, prorated plan changes, cancellation, invoices, top-ups and auto-recharge.',
    } },
  { id: 'privacy', group: { es: 'Cuenta y pagos', en: 'Account and billing' },
    title: { es: 'Privacidad y datos', en: 'Privacy and data' },
    description: {
      es: 'Qué guarda lixbon, cómo exportar tus datos, borrar el historial o eliminar la cuenta, y qué pasa con tu tarjeta.',
      en: 'What lixbon stores, how to export your data, delete your history or delete your account, and what happens to your card.',
    } },
];
