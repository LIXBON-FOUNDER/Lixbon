# shared · recursos comunes de Lixbon

Aquí viven las tipografías y los iconos de la marca, en un solo sitio, para que
lixbon.com, founder.lixbon.com, el IDE de escritorio, la app móvil y el CLI usen
exactamente los mismos archivos.

| Carpeta | Paquete | Qué contiene |
|---|---|---|
| [`fonts/`](fonts/) | `@lixbon/fonts` | Lixbon Brand Sans (interfaz y texto) y Lixbon Brand Serif (titulares), TTF + WOFF2, CSS listo, ZIP para instalar |
| [`icons/`](icons/) | `@lixbon/icons` | 145 iconos en SVG, componente React (web e IDE), componente React Native (móvil) y animaciones |

No edites copias dentro de cada app: cambia el original aquí y regenera.

## Cómo lo usa cada app

### lixbon.com y founder (`apps/web`) · IDE (`apps/desktop`)

```json
"dependencies": {
  "@lixbon/fonts": "file:../../shared/fonts",
  "@lixbon/icons": "file:../../shared/icons"
}
```

```jsx
import '@lixbon/fonts';                       // fuentes + variables --lixbon-font-sans / --lixbon-font-serif
import { Icono, usePulso, instalarPulsos } from '@lixbon/icons';
import '@lixbon/icons/css';                   // estilos y animaciones (impórtalo después de tus CSS)
```

Tras añadir las dependencias, ejecuta `npm install` en la app. `file:` crea un enlace, así que los cambios en `shared/` se ven al momento.

### App móvil (`apps/mobile`)

Las mismas dos dependencias `file:`. Metro necesita ver la carpeta, así que en `metro.config.js` va esto:

```js
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../../shared')];
module.exports = config;
```

```jsx
import { Icono } from '@lixbon/icons';        // resuelve la versión nativa sola
// fuentes: useFonts con require('@lixbon/fonts/fonts/sans/LixbonBrandSans-Regular.ttf'), ver fonts/README.md
```

### CLI (`apps/cli`, Go)

`go:embed` no puede leer fuera del módulo. Por eso `scripts/copiar-a-cli.mjs` copia en
`apps/cli/internal/weblogin/marca/` los archivos que necesita la página de login:

```bash
node shared/scripts/copiar-a-cli.mjs
```

Después, en Go, se incrustan con `//go:embed marca/*`.

## Licencias

- Lixbon Brand Sans y los iconos son propiedad de Lixbon.
- Lixbon Brand Serif es una derivada de Fraunces y va bajo la licencia SIL OFL 1.1.

Detalles en `fonts/LICENSE.md` e `icons/LICENSE.md`.

## Estado de conexión

| App | Fuentes | Iconos |
|---|---|---|
| lixbon.com y founder (`apps/web`) | ✅ conectada | ✅ conectada |
| IDE (`apps/desktop`) | pendiente | pendiente |
| Móvil (`apps/mobile`) | pendiente | pendiente |
| CLI (`apps/cli`) | pendiente | pendiente |

En `apps/web`, `vite.config.js` lleva `resolve.dedupe` (una sola copia de React) y `server.fs.allow` con `../../shared`. Las otras apps con Vite necesitan lo mismo.
