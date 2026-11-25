# LXR-1 y LXR-2 · Validación

## Alcance

43 tableros IDE, ADE y Mobile con recursos locales, índice, procedencia y SHA-256. Exportación disponible del 24-11-2026 con cambios v116/v117; no se presenta como histórica v111.

Desktop usa @lixbon/fonts, escala compartida 13/14/15/16, títulos 500, bienvenida y diálogos Serif 400, referencias Mono y colores semánticos. Se conservan los temas y los motores de editor y terminal. El resto de superficies conserva sus valores mediante fallbacks. Se corrigieron dos cierres CSS sobrantes preexistentes en agent.css detectados al compilar.

## Comprobaciones

- Desktop: 111 archivos de pruebas, 1730 pruebas aprobadas (`npm test -- --maxWorkers=2`).
- Compilación Vite aprobada; avisos de tamaño de bundle e imports dinámicos ya existentes.
- 41 hojas CSS analizadas con PostCSS sin errores.
- 43 hashes de tableros y rutas de recursos locales verificados.
- Navegador 1280 × 720: Agente 41 textos visibles / 0 fallos AA; ADE Intento en marcha 166 / 0 fallos. Se excluyen textos ocultos, SVG y controles deshabilitados; composición alfa sobre superficies de ancestros, umbral 4,5:1. Ningún tamaño fuera de la escala entre los textos medidos.
- Comprobación anterior de Ajustes: Perfil oscuro 79 textos / 0 fallos; Interfaz claro 89 / 0 fallos.
- Inspección visual de Agente y ADE y carga local de fuentes de marca. La vista previa existente del ADE usa datos simulados explícitamente etiquetados.

## Revisión y aceptación pendientes

La medición anterior cubre las vistas disponibles y no acredita todas las pantallas futuras de F2/F3. No se ha completado la matriz de gridlines ni se han adjuntado capturas comparativas exportables antes/después. La revisión de diseño del otro desarrollador y la aceptación de diferencias frente a v111 quedan pendientes; las issues siguen In Progress. Los PR posteriores completan iconos, líneas y marco de ventana sin alterar este alcance.
