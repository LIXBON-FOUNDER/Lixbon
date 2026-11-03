# @lixbon/icons

145 iconos para la web, el IDE y la app móvil. Usan una rejilla de 24 con trazo 2, uniones y extremos redondos, y dejan al menos 2 px de aire entre trazos. 35 tienen una gemela rellena para el ítem activo.

```
shared/icons/
├─ svg/linea/            todos, en línea, con currentColor
├─ svg/relleno/          gemelas rellenas, con currentColor
├─ svg/relleno-oscuro/   rellenas en #FFFFFF (modo oscuro, Figma)
├─ svg/relleno-claro/    rellenas en #000000 (modo claro)
├─ icons.json            id, nombre, grupo, apps y SVG de cada icono
├─ react/                <Icono>, usePulso() y animaciones al pulsar (web e IDE)
├─ native/               <Icono> para React Native con react-native-svg (móvil)
├─ galeria.html          buscador para copiar y descargar cada icono
└─ scripts/build-native.mjs
```

## Web e IDE (React)

```json
"dependencies": { "@lixbon/icons": "file:../../shared/icons" }
```

```jsx
import { Icono, usePulso, instalarPulsos } from '@lixbon/icons';
import '@lixbon/icons/css';                   // estilos y animaciones (impórtalo después de tus CSS)

<Icono nombre="campana" />                 // línea, toma el color del texto
<Icono nombre="visuals" relleno />         // gemela rellena (ítem activo)
instalarPulsos();                          // opcional: anima al pulsar cualquier botón con icono

const [pulso, pulsar] = usePulso();        // animación solo al pulsar
<button className={`ia ia-campana ${pulso}`} onClick={pulsar}><Icono nombre="campana" /></button>
```

En el tema claro, el relleno pasa a negro con `--lx-relleno: #000000`.

## App móvil (Expo)

El mismo import resuelve la versión nativa gracias al campo `react-native` del paquete.

```jsx
import { Icono } from '@lixbon/icons';

<Icono nombre="campana" color="#F6EEDC" />
<Icono nombre="visuals" relleno tema="oscuro" />
```

## CLI y cualquier otro sitio

Usa los `.svg` de `svg/` directamente, o lee `icons.json`.

## Añadir o cambiar un icono

1. Edita o añade el SVG en `svg/linea/` y, si tiene gemela, en `svg/relleno*/`.
2. Ejecuta `node scripts/build-native.mjs` para regenerar los datos del móvil.
3. `react/iconos-datos.js`, `react/iconos.css` e `icons.json` salieron del generador del lienzo de iconos, que no está en el repositorio. Si añades iconos a mano, actualiza también esos tres archivos.

## Animaciones

Solo se activan al pulsar, nunca al pasar el cursor. Se mueve el icono, no el botón. Son suaves y sin rebotes, duran de 300 a 900 ms y se desactivan con «reducir movimiento».

- **Un golpe:** el botón lleva `ia ia-<id>` y la clase que devuelve `usePulso()`.
- **Interruptores** (flash, ojo, estrella, corazon, fijar, microfono, candado, tema, reproducir, copiar): el botón lleva `ia ia-<interruptor>` y la clase `on` cuando está activo. Dentro, el estado apagado va en `<span class="v-off">` y el encendido en `<span class="v-on">`.
