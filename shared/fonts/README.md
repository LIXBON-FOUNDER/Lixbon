# Lixbon Brand · tipografías de marca

| Familia | Uso | Pesos | Licencia |
|---|---|---|---|
| **Lixbon Brand Sans** | Interfaz, chat, texto corrido | 300 Light · 400 Regular · 500 Medium · 600 SemiBold · 700 Bold | Propia de Lixbon |
| **Lixbon Brand Serif** | Solo titulares grandes | 300–700 (estáticas y una variable de peso) | SIL OFL 1.1 (derivada de Fraunces) |

Cobertura: español, inglés, portugués y francés (sin ß, æ, œ ni ø todavía),
cifras, puntuación habitual, `€`, comillas tipográficas y la flecha →.

```
shared/fonts/
├─ css/                 lixbon-brand.css (todo), sans.css, serif.css, serif-variable.css, tokens.css
├─ fonts/sans/          LixbonBrandSans-<Peso>.ttf / .woff2
├─ fonts/serif/         LixbonBrandSerif-<Peso>.ttf / .woff2 y LixbonBrandSerif[wght]
├─ dist/                lixbon-brand-fonts-<versión>.zip (para descargar e instalar)
├─ source/              generador (python source/package.py)
├─ LICENSE.md · OFL.txt
```

## Web (lixbon.com, founder.lixbon.com) y escritorio (Tauri)

Dependencia local en `apps/web/package.json` o `apps/desktop/package.json`:

```json
"dependencies": { "@lixbon/fonts": "file:../../shared/fonts" }
```

```js
// main.jsx
import '@lixbon/fonts';            // Sans + Serif estáticas + tokens
// o por partes:
import '@lixbon/fonts/sans.css';
import '@lixbon/fonts/serif-variable.css';
```

```css
body  { font-family: var(--lixbon-font-sans); }
h1, .titular { font-family: var(--lixbon-font-serif); font-weight: 400; }
```

Vite copia y versiona los `.woff2` solo. Sin bundler, enlaza `css/lixbon-brand.css`
manteniendo la carpeta `fonts/` al lado de `css/`.

Si sirves los archivos tú mismo desde `/fonts/`, precarga la fuente del cuerpo para que el texto no salte al cargar:

```html
<link rel="preload" href="/fonts/LixbonBrandSans-Regular.woff2" as="font" type="font/woff2" crossorigin>
```

## App móvil (Expo / React Native)

```js
import { useFonts } from 'expo-font';

const [listo] = useFonts({
  'LixbonBrandSans-Regular': require('@lixbon/fonts/fonts/sans/LixbonBrandSans-Regular.ttf'),
  'LixbonBrandSans-Medium':  require('@lixbon/fonts/fonts/sans/LixbonBrandSans-Medium.ttf'),
  'LixbonBrandSans-SemiBold':require('@lixbon/fonts/fonts/sans/LixbonBrandSans-SemiBold.ttf'),
  'LixbonBrandSerif-Regular':require('@lixbon/fonts/fonts/serif/LixbonBrandSerif-Regular.ttf'),
});
// <Text style={{ fontFamily: 'LixbonBrandSans-Regular' }}>…
```

En React Native cada peso es una familia: usa el nombre del archivo como
`fontFamily` en lugar de `fontWeight`.

## CLI (página de inicio de sesión web)

Copia los `.woff2` que necesites junto a `apps/cli/internal/weblogin/` y sírvelos con
`//go:embed`. Después declara un `@font-face` con la misma estructura que `css/sans.css`.

## Instalar en el ordenador (Figma, Keynote, Word…)

Descomprime `dist/lixbon-brand-fonts-<versión>.zip` y abre los `.ttf` de
`fonts/sans` y `fonts/serif`:

- **Windows:** clic derecho → *Instalar para todos los usuarios*.
- **macOS:** doble clic → *Instalar tipo de letra*.

Las apps las muestran como *Lixbon Brand Sans* y *Lixbon Brand Serif*, con sus pesos agrupados.

## Regenerar

```bash
cd shared/fonts
python -m pip install -r source/requirements.txt
python source/package.py      # reescribe fonts/, css/ y dist/
```

- **Lixbon Brand Sans** se dibuja con un generador de trazos: `geo.py` convierte esqueletos en contornos, `glyphs.py` define las letras y `build.py` monta la fuente, las métricas y el kerning. Para un peso nuevo, añade una fila a `SANS_WEIGHTS` en `package.py`.
- **Lixbon Brand Serif** se obtiene de `source/vendor/fraunces-latin.woff2`: el tamaño óptico se fija en 72 (aspecto de titular) y se renombra.

## Pendiente

- Sans: no tiene cursiva ni hinting manual (en pantallas de alta densidad no se nota). El kerning cubre las parejas más visibles (T, V, W, Y, A, L, P, F con minúsculas y puntuación), no todas.
- Monoespaciada de la familia: está diseñada en el lienzo, pero todavía no está empaquetada.
