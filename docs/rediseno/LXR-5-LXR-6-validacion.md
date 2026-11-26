# LXR-5 y LXR-6 · Líneas y marco

## Implementación

Variables compartidas: caja 8, texto 20, centro de iconos 28, etiqueta 46, árbol 21 por nivel y caja de menú 6. Panel central, inspector, pestañas, árbol, menús, commit y autonomía leen esas variables. Se conservan alturas y objetivos de interacción, Gutter, Collapse y tamaños guardados.

Barra superior: panel izquierdo junto a la marca, proyecto y rama, modos Agente/Editor/Diseño/Git/ADE sin transición, controles existentes. Barra de actividad Editor y ADE con iconos de 20 px, estado activo y punto ámbar. Estado muestra cursor en español y barras de uso. La vista previa conserva su aviso explícito; Hosts real queda deshabilitado si el Core no publica la vista. No se inventan porcentajes ni cuentas de hosts.

## Medición local

A 1440 × 900: centro del selector x=720 (error 0 px); todos los botones de cabecera comparten centro y=24; transición de modo 0 s; cinco iconos ADE de 20 px. Aviso de atención: caja 8, icono centrado 28, texto 46; panel central 20. Antes: panel central 16 y margen de aviso 12.

A 390 × 844: ancho del documento 390, sin desbordamiento horizontal global. Las barras conservan acceso mediante desplazamiento horizontal y el inspector usa el cajón existente. Este ancho no acredita la matriz de las 16 pantallas de escritorio.

Navegación Hosts desde el riel comprobada en navegador. Compilación aprobada. Regresión completa: 1783 pruebas aprobadas y una expectativa antigua del aviso de atención falló; actualizada al texto aprobado «9 esperan tu decisión», las 9 pruebas del archivo pasan.

## Pendiente

Matriz completa de gridlines en las 16 pantallas, capturas con guías guardadas, comparación de cada estado y revisión del otro desarrollador. Hosts y uso por agente en el ADE real dependen de los datos del Core. Las issues permanecen In Progress.
