// visuals.js — la sección Visuals: el modelo escribe un archivo (index.html o
// .svg) en un bloque ```file:… y el lienzo lo pinta. Aquí viven el prompt de
// sistema, los tipos de encargo y el parser del archivo.

export const TIPOS = [
  { id: 'landing', label: 'Landing page', hint: 'Una landing para… (producto, público, tono)',
    prefijo: 'Diseña una landing page completa para: ' },
  { id: 'componente', label: 'Componente', hint: 'Un componente de UI: tarjeta de precio, tabla, formulario…',
    prefijo: 'Crea un componente de interfaz (HTML + Tailwind, con sus estados) para: ' },
  { id: 'dashboard', label: 'Dashboard', hint: 'Un panel con métricas, tabla y gráficas…',
    prefijo: 'Diseña un dashboard de aplicación para: ' },
  { id: 'email', label: 'Email', hint: 'Una plantilla de correo (bienvenida, factura, newsletter…)',
    prefijo: 'Diseña una plantilla de email HTML (tablas, estilos en línea, 600px) para: ' },
  { id: 'logo', label: 'Logo / SVG', hint: 'Un logotipo, icono o ilustración vectorial',
    prefijo: 'Dibuja en SVG (archivo logo.svg) un logotipo o ilustración para: ' },
  { id: 'prototipo', label: 'Prototipo', hint: 'Varias pantallas enlazadas (app, flujo de registro…)',
    prefijo: 'Crea un prototipo navegable de varias pantallas para: ' },
];

export const VISUALS_PROMPT = `Eres el diseñador de interfaces de Lixbon Visuals. Produces diseños reales, no maquetas genéricas.

FORMATO (obligatorio):
- Entrega SIEMPRE el archivo COMPLETO dentro de un bloque de código cuyo lenguaje sea file:index.html (o file:logo.svg si piden un logo, icono o ilustración vectorial). Un solo bloque por respuesta. En cada cambio, por pequeño que sea, vuelve a entregar el archivo entero actualizado.
- Antes del bloque: una frase con lo que has hecho. Después: como mucho tres viñetas con opciones de cambio. Nunca expliques el código.

HTML:
- Un solo archivo autocontenido: <!doctype html>, <html lang>, <meta viewport>, <title>. Estilos en <style> y scripts en <script> dentro del archivo.
- Puedes cargar Tailwind con <script src="https://cdn.tailwindcss.com"></script> y fuentes de Google Fonts. Ningún otro recurso externo.
- Imágenes: SVG inline o https://picsum.photos/seed/<palabra>/<ancho>/<alto>. Iconos: SVG inline (no emojis).
- Textos reales y coherentes con el encargo, en el idioma del usuario. Nada de lorem ipsum ni "Título aquí".
- Responsive (móvil primero). Estados hover/focus/disabled donde toque. Accesible: contraste, alt, labels.
- Prototipos: cada pantalla es un <section data-screen="nombre">; solo una visible; navegación con JS entre ellas.
- Componentes: muéstralos dentro de una página de demostración con fondo neutro y el componente centrado, en sus variantes.
- SVG: viewBox definido, sin tamaño fijo, formas limpias, sin texto rasterizado ni filtros pesados.

DISEÑO:
- Jerarquía clara: una tipografía display y una de cuerpo, escala tipográfica consistente, espaciado en múltiplos de 8 px, mucho aire.
- Paleta contenida: fondo, texto, un acento. Nada de degradados morados por defecto ni sombras exageradas.
- Composición con intención: alineación a rejilla, anchos máximos de lectura, ritmo vertical.
- Si el usuario da marca, colores o referencias, respétalos al pie de la letra.`;

const FENCE = /```file:([^\n`]+)\n([\s\S]*?)(?:\n```|$)/g;

/** Último archivo de un texto (aunque el bloque aún esté abierto) y si cerró. */
export function extraerArchivo(texto) {
  if (!texto) return null;
  let ultimo = null;
  for (const m of texto.matchAll(FENCE)) {
    const cerrado = texto.slice(m.index + m[0].length - 3, m.index + m[0].length) === '```';
    ultimo = { name: m[1].trim(), code: m[2], cerrado };
  }
  return ultimo;
}

export function esSvg(name) {
  return /\.svg$/i.test(name || '');
}

/** Documento que pinta el lienzo: el HTML tal cual, o el SVG centrado. */
export function documentoPreview(archivo) {
  if (!archivo) return '';
  if (esSvg(archivo.name)) {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;height:100%;background:#f4f4f2;display:grid;place-items:center}
      svg{max-width:min(80vw,560px);max-height:80vh;width:100%;height:auto}
    </style></head><body>${archivo.code}</body></html>`;
  }
  return archivo.code;
}

export const DISPOSITIVOS = [
  { id: 'movil', label: 'Móvil', ancho: 390 },
  { id: 'tablet', label: 'Tablet', ancho: 820 },
  { id: 'escritorio', label: 'Escritorio', ancho: 0 },
];
