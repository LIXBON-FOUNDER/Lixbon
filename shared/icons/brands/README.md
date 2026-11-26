# Marcas de los servicios

`BrandIcon` conserva los SVG de los lienzos aprobados de `design/boards` sin redibujar sus trazados. `data.js` registra el archivo de origen de cada marca. Claude conserva su color y las demás marcas heredan el color del texto, sin fondo.

```jsx
import { BrandIcon } from '@lixbon/icons/brands';
<BrandIcon name="claude" size={16} />
<BrandIcon name="codex" size={16} />
<BrandIcon name="chatgpt" size={16} />
```

Codex y ChatGPT usan el símbolo de OpenAI presente en el lienzo; los alias no cambian la identidad ni el nombre del proveedor. También están disponibles GitHub, Linear y Slack. Un nombre desconocido no dibuja una marca. `hasBrand(name)` permite elegir un icono genérico como alternativa.

Son marcas de sus respectivos titulares. Su inclusión en este catálogo no las convierte en iconos originales de Lixbon ni modifica sus derechos de marca.
