# LXR-24 y LXR-25 · Fundaciones móviles

Fuentes Sans regular/medium y Serif regular desde shared/fonts; escala TEXT, seguimiento 0,1 y números tabulares mediante Text/TextInput compartidos. Se conservan claro/oscuro/Auto y la personalización del chat, así como código y terminal en Mono. Botones destructivos usan #CF3A20 y blanco. Textos existentes conservados.

Iconos Native compartidos con Desktop para estados y archivos, incluidos menciones y adjuntos. Logos de agentes sin discos de fondo; personas conservan sus avatares. El anillo gira en 900 ms y respeta reducir movimiento del sistema. Estados de Atención usan escudo, pregunta y pull request; el ojo queda para Supervisar. Avisos sin conexión distinguen teléfono y host.

## Comprobaciones

- 196 pruebas móviles aprobadas (45 suites), incluidas pruebas de contraste 4,5:1 para textos/superficies claro y oscuro y botón destructivo.
- 104 módulos analizados sintácticamente y vinculaciones de Text/TextInput comprobadas.
- Bundle Android de Expo aprobado: 1456 módulos, incluye 3 fuentes de marca compartidas y 2 Mono existentes.
- Metro observa shared/ y resuelve el paquete local @lixbon/icons.

## Pendiente

ADB no tiene dispositivos conectados. No se acreditan capturas del emulador/teléfono, contraste de cada texto renderizado de F2/F3 ni gridlines por pantalla. Revisión del otro desarrollador pendiente; las issues siguen In Progress. Esta comprobación cubre el bundle JavaScript/recursos, no una compilación Gradle ni ejecución nativa.
