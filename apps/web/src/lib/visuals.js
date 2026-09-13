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
- Entrega SIEMPRE cada archivo COMPLETO dentro de un bloque de código cuyo lenguaje sea file:nombre (file:index.html; file:logo.svg si piden un logo, icono o ilustración vectorial). En cada cambio, por pequeño que sea, vuelve a entregar entero el archivo que cambia (los que no cambian puedes omitirlos).
- Un sitio o prototipo de varias pantallas va en VARIAS páginas: una por bloque (file:index.html, file:sitios.html, file:contacto.html…), enlazadas con <a href="sitios.html">. La primera siempre es index.html. Cada página repite su cabecera y pie.
- Antes del bloque: una frase con lo que has hecho. Después: como mucho tres viñetas con opciones de cambio. Nunca expliques el código.

HTML:
- Un solo archivo autocontenido: <!doctype html>, <html lang>, <meta viewport>, <title>. Estilos en <style> y scripts en <script> dentro del archivo.
- Puedes cargar Tailwind con <script src="https://cdn.tailwindcss.com"></script> y fuentes de Google Fonts. Ningún otro recurso externo.
- Imágenes: SVG inline o https://picsum.photos/seed/<palabra>/<ancho>/<alto>. Iconos: SVG inline (no emojis).
- Textos reales y coherentes con el encargo, en el idioma del usuario. Nada de lorem ipsum ni "Título aquí".
- Responsive (móvil primero). Estados hover/focus/disabled donde toque. Accesible: contraste, alt, labels.
- Prototipos de app: cada pantalla es una página (file:inicio.html, file:detalle.html…) enlazada con <a href>; el lienzo las muestra como artboards.
- Componentes: muéstralos dentro de una página de demostración con fondo neutro y el componente centrado, en sus variantes.
- SVG: viewBox definido, sin tamaño fijo, formas limpias, sin texto rasterizado ni filtros pesados.

DISEÑO:
- Jerarquía clara: una tipografía display y una de cuerpo, escala tipográfica consistente, espaciado en múltiplos de 8 px, mucho aire.
- Paleta contenida: fondo, texto, un acento. Nada de degradados morados por defecto ni sombras exageradas.
- Composición con intención: alineación a rejilla, anchos máximos de lectura, ritmo vertical.
- Si el usuario da marca, colores o referencias, respétalos al pie de la letra.`;

const FENCE = /```file:([^\n`]+)\n([\s\S]*?)(?:\n```|$)/g;

/** Todos los archivos de un texto, en orden; el último puede estar abierto. */
export function extraerArchivos(texto) {
  if (!texto) return [];
  const out = [];
  for (const m of texto.matchAll(FENCE)) {
    const cerrado = texto.slice(m.index + m[0].length - 3, m.index + m[0].length) === '```';
    out.push({ name: m[1].trim(), code: m[2], cerrado });
  }
  return out;
}

/** Último archivo de un texto (aunque el bloque aún esté abierto) y si cerró. */
export function extraerArchivo(texto) {
  const todos = extraerArchivos(texto);
  return todos.length ? todos[todos.length - 1] : null;
}

// ── Design systems: reglas fijas que entran en el prompt ─────────────────────

export const DESIGN_SYSTEMS = [
  { id: 'libre', label: 'Libre', desc: 'El modelo decide según el encargo', prompt: '' },
  { id: 'lixbon', label: 'Lixbon', desc: 'Oscuro, acento oliva, Inter',
    prompt: 'Fondo #0E0E0E, superficies #131313/#1C1C1C, texto #F2F2F0, secundario #B0B0AD, acento #B4C64E (solo en acciones y foco). Tipografía Inter (Google Fonts) para todo, títulos semibold con letter-spacing -0.02em. Radios 8 px, bordes rgba(255,255,255,.08), sin sombras salvo en elementos flotantes. Tono sobrio y técnico.' },
  { id: 'editorial', label: 'Editorial', desc: 'Serif, blanco roto, mucho aire',
    prompt: 'Fondo #FAF8F3, texto #1A1A1A, acento #B23A2E. Títulos en Fraunces o Playfair Display (Google Fonts), cuerpo en Source Serif 4 o Inter. Columnas de lectura de 60-70 caracteres, márgenes generosos, reglas finas de 1 px, imágenes grandes a sangre. Tono revista.' },
  { id: 'minimal', label: 'Minimal', desc: 'Blanco, gris, una tinta',
    prompt: 'Fondo #FFFFFF, texto #111111, gris #6B6B6B, líneas #E6E6E6, un solo acento #111111 (botones negros, texto blanco). Tipografía Inter o Geist. Sin sombras, sin degradados, radios 6 px, espaciado amplio en múltiplos de 8. Tono limpio y directo.' },
  { id: 'corporativo', label: 'Corporativo', desc: 'Azul confianza, sans clásica',
    prompt: 'Fondo #FFFFFF y secciones #F5F7FA, texto #0F172A, acento #1D4ED8 con hover #1E40AF, éxito #15803D. Tipografía Inter o IBM Plex Sans. Tarjetas con borde #E2E8F0 y radio 12 px, sombra suave solo en hover. Tono claro y fiable, sin adornos.' },
  { id: 'vibrante', label: 'Vibrante', desc: 'Color saturado, formas grandes',
    prompt: 'Fondo #FFF8E7, texto #1B1B1B, acentos #FF5A36 y #2E6CF6, amarillo #FFC53D en detalles. Tipografía display grande y pesada (Space Grotesk o Syne), cuerpo Inter. Botones pill, radios 20+ px, formas geométricas decorativas, contraste alto. Tono enérgico, para consumo.' },
  { id: 'tech', label: 'Dark tech', desc: 'Negro azulado, mono en detalles',
    prompt: 'Fondo #0B0F19, superficies #111827, bordes #1F2937, texto #E5E7EB, secundario #9CA3AF, acento #22D3EE con brillo sutil. Tipografía Inter para el cuerpo y JetBrains Mono para etiquetas, números y código. Rejilla fina de fondo, badges y gráficos. Tono producto para desarrolladores.' },
];

/** Design system propio a partir de un formulario sencillo. */
export function designSystemPersonalizado(form) {
  const { nombre, primario, fondo, texto, fuenteTitulos, fuenteCuerpo, tono } = form;
  const partes = [];
  if (fondo) partes.push(`Fondo ${fondo}`);
  if (texto) partes.push(`texto ${texto}`);
  if (primario) partes.push(`acento ${primario} (botones, enlaces, foco)`);
  if (fuenteTitulos) partes.push(`títulos en ${fuenteTitulos}`);
  if (fuenteCuerpo) partes.push(`cuerpo en ${fuenteCuerpo}`);
  if (tono) partes.push(`tono: ${tono}`);
  return { id: 'custom', label: nombre || 'Personalizado', desc: 'definido por ti', prompt: `${partes.join('. ')}.`, custom: true, form };
}

export function promptVisuals(designSystem) {
  if (!designSystem?.prompt) return VISUALS_PROMPT;
  return `${VISUALS_PROMPT}\n\nDESIGN SYSTEM «${designSystem.label}» (obligatorio en todas las páginas y versiones): ${designSystem.prompt}`;
}

// ── Inspector y navegación entre páginas dentro del iframe ───────────────────
// Se inyecta antes de </body>. Habla con la página padre por postMessage:
//   lixbon:select   (clic con el inspector activo) → selector, texto, estilos
//   lixbon:navigate (clic en <a href="otra.html">) → cambia de página
//   lixbon:apply    (padre → iframe) → aplica texto/estilos a un selector
const INSPECTOR = String.raw`<script>(function(){
if (window.parent === window) return;
var inspect = false, box = document.createElement('div');
box.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #B4C64E;border-radius:3px;z-index:2147483647;display:none;box-shadow:0 0 0 2px rgba(0,0,0,.25)';
document.body.appendChild(box);
function path(el){var parts=[];while(el&&el.nodeType===1&&el!==document.body&&el!==document.documentElement){var p=el.parentElement;var i=p?Array.prototype.indexOf.call(p.children,el)+1:1;parts.unshift(el.tagName.toLowerCase()+':nth-child('+i+')');el=p;}return 'body > '+parts.join(' > ');}
function show(el){var r=el.getBoundingClientRect();box.style.display='block';box.style.left=r.left+'px';box.style.top=r.top+'px';box.style.width=r.width+'px';box.style.height=r.height+'px';}
document.addEventListener('mousemove',function(e){if(!inspect)return;var el=e.target;if(!el||el===box||el===document.body||el===document.documentElement)return;show(el);},true);
document.addEventListener('click',function(e){
  var a=e.target.closest&&e.target.closest('a[href]');
  if(!inspect&&a){var h=a.getAttribute('href')||'';if(/^[^:\/#][^:]*\.html(#.*)?$/.test(h)){e.preventDefault();parent.postMessage({type:'lixbon:navigate',page:h.split('#')[0]},'*');}return;}
  if(!inspect)return;e.preventDefault();e.stopPropagation();var el=e.target;if(el===box)return;var cs=getComputedStyle(el);
  parent.postMessage({type:'lixbon:select',selector:path(el),tag:el.tagName.toLowerCase(),text:el.children.length===0?el.textContent:'',html:el.outerHTML.slice(0,800),styles:{color:cs.color,background:cs.backgroundColor,fontSize:cs.fontSize,fontWeight:cs.fontWeight,padding:cs.padding,borderRadius:cs.borderRadius}},'*');
},true);
function apply(op){var el=document.querySelector(op.selector);if(!el)return;if(op.text!=null)el.textContent=op.text;if(op.style)for(var k in op.style)el.style[k]=op.style[k];}
window.addEventListener('message',function(e){var m=e.data||{};if(m.type==='lixbon:apply')apply(m);if(m.type==='lixbon:inspect'){inspect=!!m.on;box.style.display='none';}});
(window.__lixbonOps||[]).forEach(apply);
})();</script>`;

function conInspector(html, ops) {
  const previos = ops && ops.length ? `<script>window.__lixbonOps=${JSON.stringify(ops)}</script>` : '';
  const inyeccion = `${previos}${INSPECTOR}`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${inyeccion}</body>`) : `${html}${inyeccion}`;
}

/** Aplica las ediciones manuales al HTML fuente (sin ejecutar scripts). */
export function aplicarOps(html, ops) {
  if (!ops || !ops.length) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const op of ops) {
    const el = doc.querySelector(op.selector);
    if (!el) continue;
    if (op.text != null) el.textContent = op.text;
    if (op.style) for (const k of Object.keys(op.style)) el.style[k] = op.style[k];
  }
  const tieneDoctype = /^\s*<!doctype/i.test(html);
  return `${tieneDoctype ? '<!doctype html>\n' : ''}${doc.documentElement.outerHTML}`;
}

export function esSvg(name) {
  return /\.svg$/i.test(name || '');
}

/** Documento que pinta el lienzo: el HTML con el inspector, o el SVG centrado. */
export function documentoPreview(archivo, ops = []) {
  if (!archivo) return '';
  if (esSvg(archivo.name)) {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;height:100%;background:#f4f4f2;display:grid;place-items:center}
      svg{max-width:min(80vw,560px);max-height:80vh;width:100%;height:auto}
    </style></head><body>${archivo.code}</body></html>`;
  }
  return conInspector(archivo.code, ops);
}

export const TIPO_IMAGEN = {
  id: 'imagen', label: 'Imagen', hint: 'Describe la imagen: sujeto, estilo, luz, encuadre…', prefijo: '',
};

export const TAMANOS_IMAGEN = [
  { id: 'cuadrado', label: '1:1', width: 1024, height: 1024 },
  { id: 'apaisado', label: '16:9', width: 1344, height: 768 },
  { id: 'vertical', label: '9:16', width: 768, height: 1344 },
];

const IMG_MD = /!\[([^\]]*)\]\((data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+)\)/;

/** Imagen generada guardada como Markdown en un mensaje. */
export function extraerImagen(texto) {
  const m = IMG_MD.exec(texto || '');
  return m ? { alt: m[1], src: m[2] } : null;
}

export function esConversacionDeImagenes(messages) {
  return messages.some((m) => m.role === 'assistant' && extraerImagen(m.content));
}

export const DISPOSITIVOS = [
  { id: 'movil', label: 'Móvil', ancho: 390 },
  { id: 'tablet', label: 'Tablet', ancho: 820 },
  { id: 'escritorio', label: 'Escritorio', ancho: 0 },
];
