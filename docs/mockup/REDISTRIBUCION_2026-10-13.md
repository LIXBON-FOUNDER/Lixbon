# Lixbon — redistribución y jerarquía de las maquetas

Fecha: 2026-10-13
Rama de trabajo: codex/design-mockup-hierarchy
Estado: propuesta concreta para revisión; cambios de interfaz todavía no aplicados.

## Objetivo y límites

Reducir la información simultánea, explicar mejor el trabajo y conservar la identidad visual existente: superficies oscuras, acento lima, Hanken Grotesk y JetBrains Mono. ADE, IDE, CLI y Mobile siguen siendo maquetas con datos ficticios y un store compartido en memoria.

La aprobación de dirección viene de la conversación: redistribuir funciones entre ADE, IDE y Mobile, mejorar jerarquía y después animaciones e iconos. No se modifica Core, IPC, proveedores, Git real, backend, configuración de producción ni src/ade. No se publica ni se hace merge.

Los archivos anteriores siguen sin commit. Cambiar de rama no crea una copia independiente de esos archivos; antes de editar se guardará una copia local de la maqueta original para comparación y recuperación.

## Dirección elegida

Se conserva la estructura existente y se introduce detalle progresivo. Una alternativa sería cambiar toda la navegación y otra limitarse a reducir tamaños; ambas quedan fuera de esta iteración. La propuesta mantiene orientación y reduce información repetida sin hacer más pequeño el texto.

## 1. ADE: dirigir y supervisar

- Separar navegación global (Attention, trabajo, mapa, hosts y consumo) de navegación dentro de una Task.
- En el Workspace, mostrar dos columnas por defecto: sidebar y contenido. Inspector se abre con Detalles, conserva Task / Changes / Context / Autonomy y puede cerrarse sin perder selección.
- Cabecera principal: título de Task, estado y acción Abrir en IDE. Una fila de contexto muestra Attempt, agente y host. Branch, worktree completo, effort, policy y ContextPackage se consultan al desplegar Contexto.
- La política efectiva continúa visible antes de cualquier lanzamiento o aprobación. El detalle progresivo no oculta el alcance de una decisión.
- Acciones secundarias (Pause, Take Over, Compare) se agrupan en un menú con texto; el control humano activo permanece indicado.
- Attempts se muestran como alternativas de la Task; con un solo Attempt se evita una tira adicional redundante.
- Sustituir el bloque permanente de métricas por un resumen compacto de cambios y validación. Tiempo, costo, tokens y ubicación completa se abren bajo Actividad y recursos.
- Pending Queue inicia plegada con cantidad y siguiente instrucción. Desplegar permite editar, reordenar y convertir como ahora.
- Attention mantiene decisiones separadas de Activity. Cada aprobación conserva comando, razón, alcance, agente, Attempt y host; ninguna reorganización agrupa decisiones de alto impacto.
- Review ready con pruebas fallidas muestra el fallo junto al estado. Listo para revisión no implica verificado.

## 2. IDE: editar, revisar y resolver

- Conservar una barra de contexto: Task / Attempt / branch / host. Eliminar repetición de ese contexto en franjas decorativas.
- El editor ocupa el centro. Explorer, terminal y agente lateral pueden plegarse; los paneles recuperan su última apertura durante la sesión de la maqueta.
- La revisión detallada pasa a una vista Review dentro del IDE: archivos, diff, comentarios y filtros. ADE conserva Proof Pack y previsualización, y abre el mismo Attempt y revisión en IDE.
- Un enlace permite volver al Proof Pack sin perder el archivo ni los comentarios pendientes.
- Resolución de conflictos se presenta en IDE. ADE conserva el aviso y el acceso al resultado.
- Aceptado, pendiente de integración e integrado son conceptos distintos. En la maqueta, aceptar un resultado no afirma que se hizo un merge real.
- Mostrar revisión pendiente al aceptar sin haber recorrido todos los archivos; no afirmar que marcar archivos revisados prueba calidad.

## 3. Mobile: decidir y seguir

- Navegación: Attention / Trabajo / Más. Si existen decisiones pendientes se abre Attention; en caso contrario se presenta un resumen sin urgencia artificial.
- Attention muestra primero bloqueos y preguntas, después resultados por revisar y problemas. Trabajo agrupa Attempts por Task.
- Más contiene hosts, consumo y conexión. La actividad histórica se consulta desde la Task y deja de ocupar Home.
- Cabecera de decisiones: host de ejecución destacado. Si se muestra el host de conexión se etiqueta como Conectado a para evitar confusión con Ejecuta en.
- Mantener comando completo con salto de línea, alcance, motivo y controles cómodos. Las instrucciones pendientes se consultan al abrir su contador.
- Review summary permite pedir cambios, responder y continuar en Desktop. Para resultados sensibles o comprobaciones fallidas, revisión completa en Desktop es la acción principal.
- Conservar Queue / Steer / Stop & Send y Fork avanzado con significado explícito. No simular capacidades nativas que el proveedor no tiene.

## 4. CLI: consistencia

- No rediseñar el terminal en esta etapa. Mantener comandos simulados y datos compartidos.
- Mejorar status con identificador de Attempt y host para distinguir resultados de la misma Task.
- Mantener el salto al IDE sobre el Attempt elegido; la salida explica si abre edición o revisión.

## 5. Sistema visual e iconos

- Tres niveles legibles: título, contenido principal y metadatos. Como punto inicial de diseño: 20–24 px para títulos, 13–14 px para contenido Desktop, 14–16 px para contenido Mobile; metadatos legibles, sin resolver densidad reduciendo tipografía.
- Usar la escala de espaciado existente, con separación más clara entre cabecera, contenido y acciones. Los valores definitivos se ajustan con capturas.
- Una acción primaria por bloque. Controles secundarios usan menor contraste, sin perder foco de teclado ni legibilidad.
- Acento lima para selección y acción principal; estado conserva texto e icono y no depende solo del color.
- Revisar los iconos disponibles y mantener una familia consistente con la actual: mismos tamaños, peso y significado. No cambiar la biblioteca global ni crear iconos decorativos innecesarios.
- Icono con texto en acciones importantes; tooltip y nombre accesible para controles compactos. Los controles táctiles principales apuntan a 44–48 px.
- Densidad cómoda por defecto. Compacta puede explorarse después de validar la jerarquía; no se necesita para completar esta etapa.

## 6. Animación al servicio de la orientación

- Primero estabilizar distribución; después introducir movimiento.
- Estados de interacción: 120–160 ms. Paneles y detalles: 180–220 ms. Transiciones locales: 180–240 ms, como valores iniciales para evaluar.
- Animar opacity y transform cuando sea posible, evitando desplazamientos del editor y cambios de selección automáticos.
- Un evento de fondo actualiza el estado sin mover el workspace, reordenar el árbol o robar foco.
- Pending muestra confirmación breve al recibir una instrucción. La apertura de detalles y el paso a revisión hacen evidente la continuidad del Attempt.
- Respetar prefers-reduced-motion: eliminar desplazamientos y animaciones repetitivas; mantener feedback textual y estados estáticos.
- No usar loaders que sugieran ejecución real; el indicador de maqueta permanece visible.

## Archivos previstos

Solo apps/desktop/src/mockup/** y docs/mockup/**. La entrada mockup.html y vite.mockup.config.js se mantienen aisladas del producto.

AdeDesktop.jsx, TaskWorkspace.jsx, Composer.jsx, Inspector.jsx y Sidebar.jsx: jerarquía y detalle progresivo.
IdeDesktop.jsx y ReviewViewer.jsx: revisión dentro del IDE y navegación de ida y vuelta.
MobileApp.jsx: navegación y decisiones.
CliTerminal.jsx: identificadores y host.
ui.jsx y styles/*.css: consistencia, accesibilidad y movimiento dentro de la maqueta.
store.js: únicamente estado ficticio necesario para paneles y selección de revisión; no inventar persistencia o integración real.

## Secuencia de implementación posterior a la revisión

1. Guardar referencia original y comprobar las pruebas existentes del mockup.
2. Redistribuir Workspace ADE y simplificar sus repeticiones.
3. Conectar revisión en IDE y reorganizar Mobile, manteniendo datos y selección.
4. Afinar copy, estados, iconos y tamaños.
5. Añadir movimiento y reduced motion.
6. Verificar visualmente y documentar resultados y límites.

## Criterios para evaluar la maqueta

- En el Workspace inicial no aparecen simultáneamente inspector completo, contexto expandido, métricas completas y cola completa.
- El usuario identifica Task, Attempt, estado y host sin abrir varias pantallas.
- Detalles, cola y recursos pueden abrirse y cerrarse con controles etiquetados.
- ADE → Review en IDE → Proof Pack conserva Attempt, revisión y comentarios en la sesión simulada.
- Mobile distingue host de conexión y host de ejecución, y las decisiones no pierden comando o alcance.
- Queue / Steer / Stop & Send conservan la semántica y las confirmaciones existentes.
- Comparación no premia un empate y distingue resultados provisionales de terminados.
- Capturas Desktop a 1440×900 y 1280×800; Mobile a 390×844 y 360×800. Evitar recortes de acciones esenciales.
- Teclado: foco visible, Escape cierra overlays y el retorno de foco es comprensible. Reduced motion no deja acciones sin feedback.
- Ejecutar pruebas existentes apropiadas de src/mockup; añadir pruebas de continuidad o estado solo si la redistribución modifica esos recorridos.
- Informar por separado verificación visual, pruebas locales y capacidades simuladas. Ningún resultado es evidencia del Core real.

## Revisión de esta propuesta

La revisión solicitada es de distribución: ubicación de Review en IDE, detalle progresivo en ADE y navegación Attention / Trabajo / Más en Mobile. Una vez revisada esta especificación, se concreta el plan de implementación y su ejecución según el flujo de diseño.
