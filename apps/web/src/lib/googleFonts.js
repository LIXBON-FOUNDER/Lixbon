// Tipografías para el editor de piezas: las de marca (las inyecta paraWeb y el
// renderizador) y una selección de Google Fonts que se enlazan en la propia pieza.
export const FUENTES_MARCA = ['Geist', 'Geist Mono', 'Bruno Ace SC'];

export const FUENTES_GOOGLE = {
  sans: ['Inter', 'Manrope', 'DM Sans', 'Plus Jakarta Sans', 'Space Grotesk', 'Montserrat', 'Poppins', 'Outfit',
    'Sora', 'Figtree', 'Work Sans', 'Rubik', 'Nunito', 'Lato', 'Open Sans', 'Roboto', 'Raleway', 'Archivo',
    'IBM Plex Sans', 'Onest'],
  serif: ['Playfair Display', 'Fraunces', 'Instrument Serif', 'DM Serif Display', 'Lora', 'Merriweather',
    'Cormorant Garamond', 'EB Garamond', 'Libre Baskerville', 'Source Serif 4'],
  display: ['Bebas Neue', 'Anton', 'Oswald', 'Archivo Black', 'Bricolage Grotesque', 'Syne', 'Unbounded',
    'Abril Fatface', 'Righteous', 'Bungee'],
  mono: ['JetBrains Mono', 'Space Mono', 'IBM Plex Mono', 'Fira Code', 'DM Mono'],
  hand: ['Caveat', 'Pacifico', 'Dancing Script', 'Permanent Marker', 'Kalam'],
};

const RESPALDO = { sans: 'sans-serif', serif: 'serif', display: 'sans-serif', mono: 'monospace', hand: 'cursive' };

export const categoriaDe = (familia) =>
  Object.keys(FUENTES_GOOGLE).find((c) => FUENTES_GOOGLE[c].includes(familia));

export const pilaDe = (familia) => `"${familia}", ${RESPALDO[categoriaDe(familia)] || 'sans-serif'}`;

export const primeraFamilia = (pila) => (pila || '').split(',')[0].trim().replace(/^["']|["']$/g, '');

const familia = (f, ejes = '') => `family=${encodeURIComponent(f).replace(/%20/g, '+')}${ejes}`;
const url = (partes, extra = '') => `https://fonts.googleapis.com/css2?${partes.join('&')}${extra}&display=swap`;

/** Muestra cada nombre en su propia letra: Google sirve solo los glifos de `text`. */
export function cargarMuestras(familias) {
  if (typeof document === 'undefined' || document.querySelector('link[data-lixbon-muestras]')) return;
  const letras = [...new Set(familias.join(''))].join('');
  const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: url(familias.map((f) => familia(f)), `&text=${encodeURIComponent(letras)}`) });
  link.dataset.lixbonMuestras = '';
  document.head.append(link);
}

// Google rechaza la petición entera (400) si la fuente no tiene un eje o un peso pedido,
// así que se prueba de más completo a más simple. Se sondea con <link> y no con fetch
// porque las respuestas 400 no traen cabecera CORS.
const EJES = [':ital,wght@0,100..900;1,100..900', ':ital,wght@0,400..900;1,400..900', ':wght@100..900',
  ':ital,wght@0,400;0,700;1,400;1,700', ':wght@400;700', ''];

const cargaLink = (doc, href) => new Promise((ok) => {
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.onload = () => ok(link);
  link.onerror = () => { link.remove(); ok(null); };
  doc.head.append(link);
});

/** Enlaza la fuente en la pieza (se guarda con ella y la usa el render). */
export async function enlazarFuente(doc, nombre) {
  if (FUENTES_MARCA.includes(nombre)) return true;
  const ya = [...doc.querySelectorAll('link[data-lixbon-gfont]')].some((l) => l.dataset.lixbonGfont === nombre);
  if (ya) return true;
  for (const ejes of EJES) {
    const link = await cargaLink(doc, url([familia(nombre, ejes)]));
    if (link) {
      link.dataset.lixbonGfont = nombre;
      await doc.fonts?.load(`16px "${nombre}"`).catch(() => {});
      return true;
    }
  }
  return false;
}
