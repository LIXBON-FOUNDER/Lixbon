# LXR-26 y LXR-27 · Líneas y movimiento móvil

## Implementación

Constantes TEXTO=20, ICONO_CENTRO=32, ETIQUETA=56 y CAJA=8; LINEAS añade relleno 12, iconos 24, menú 6/18/50 y tacto 44. Las usan cabeceras, filas, avisos, secciones, menú lateral y pantallas. Se preservan historial plegable/paginado y sus acciones de pulsación prolongada, y StepSlider.

Hoja inferior en Reanimated + Gesture Handler 2.28 (versión indicada por Expo 54): abre en 380 ms, cierra en 220, curva (.32,.72,0,1), sigue el arrastre con fricción hacia arriba. Se cierra a 120 px o velocidad descendente >0,4 px/ms. Un gesto cancelado vuelve al origen. El cierre por teclado/accesibilidad y la API por promesas se conservan.

El selector de modelo del chat abre un menú anclado al chip: escala inicial 0,96, opacidad, 180/120 ms y curva (.23,1,.32,1). Desde comandos sin ancla se conserva la hoja. Segmentos: traslación de 200 ms y curva (.77,0,.175,1), sin animar ancho. Pulsación compartida a escala 0,97. Cambio de modelo: fundido de 180 ms con capa estática de desenfoque de 2 px. Spinner de cabecera 800 ms. Con movimiento reducido no se animan desplazamientos ni escala en estos componentes.

Como endurecimiento de LXR-1 se fijan LF en los tableros: los SHA-256 del manifiesto deben conservarse al hacer checkout también en Windows.

## Validación

- Tablero MovilMovimiento abierto localmente: menú del chip, selección qwen3-coder y cierre del menú probados; hoja abierta y cerrada arrastrando la barra hacia abajo.
- 198 pruebas móviles aprobadas, incluidas fronteras de distancia/velocidad y fricción: 120 lento cierra; 119/60 lentos no; 60 a 0,41 px/ms cierra; 0,4 exactos no; hacia arriba no cierra.
- 110 módulos analizados y vinculaciones de hooks/componentes/tokens verificadas.
- Expo export Android aprobado: 1546 módulos y fuentes incluidas. No equivale a build Gradle ni ejecución en teléfono.
- git diff --check aprobado.

## Pendiente de aceptación

ADB no tiene dispositivos conectados. Faltan mediciones y capturas de gridlines en cada pantalla, ejecución de gestos en Android real, vídeo comparativo, validación de desenfoque/teclado y revisión del otro desarrollador. Las issues siguen In Progress. Las constantes y el bundle no acreditan por sí solos la fidelidad visual completa.

## Dependencias

La consulta en línea de npm audit encuentra 18 alertas en dependencias preexistentes (3 altas: image-size, markdown-it y node-forge). Las entradas anteriores del lockfile conservan sus versiones; la dependencia de gestos añade cinco paquetes y ninguno aparece en ese informe. No se aplica una actualización mayor automática de Expo en un cambio de diseño.
