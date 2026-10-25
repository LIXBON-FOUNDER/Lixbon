# Validación de la maqueta — 2026-10-13

Rama: codex/design-mockup-hierarchy. Cambios sin commit.
Preview local: http://localhost:5179/mockup.html

## Cambios aplicados

ADE: dos columnas por defecto, inspector opcional, contexto y recursos desplegables, cola plegada, cabecera y sidebar simplificados. El compositor conserva política y permanece visible al desplazar actividad. Actions agrupa controles secundarios.
IDE: ReviewViewer integrado, Explorer/terminal/agente plegables; selección, archivo, filtro, comentarios y borrador conservados por Attempt al volver de Proof Pack.
Mobile: Attention / Work / More, decisiones por prioridad, tareas agrupadas, hosts y consumo bajo More, conexión y host de ejecución diferenciados. Sin decisiones muestra resumen tranquilo. Los resultados sensibles se revisan en Desktop.
CLI: status incluye Attempt ID y host; abrir IDE vuelve a edición aunque antes estuviera en revisión.
Comparación: empates sin ganador exclusivo; resultados en ejecución etiquetados provisionales.
Aceptación: integración pendiente explícita; no representa un merge real.
Movimiento: transiciones locales, iconos existentes coherentes, foco visible y regla prefers-reduced-motion. Sin nuevas dependencias.

## Referencia y alcance

Respaldo: docs/mockup/baseline-2026-10-13.zip, antes de cualquier cambio de interfaz.
Comparación de hashes con respaldo: 12 archivos existentes cambiados dentro de src/mockup; archivos nuevos hierarchy.test.jsx y styles/hierarchy.css. Showcase.jsx solo cambió finales de línea. mockup.html y vite.mockup.config.js conservan su contenido original.
Git diff --name-only no muestra modificaciones a archivos versionados del producto. .claude/launch.json preexistía sin commit y no fue editado.

## Pruebas

Línea base: 34/34 pruebas aprobadas.
Cinco pruebas nuevas fallaron antes de implementar, por ausencia de navegación Review, dock abierto, estado de integración ausente, hosts ambiguos y ganador de empate.
Final: node node_modules/vitest/vitest.mjs run src/mockup --environment jsdom --maxWorkers=1
Resultado: 2 archivos, 44/44 pruebas aprobadas; duración 62.92 s.
Se añadieron comprobaciones de navegación, estado compartido, orden de cola, selección actual en atajo, CLI tras revisión, filtro Since last review y persistencia de archivo/borrador.
Una ejecución intermedia agotó el límite de 5 s de una prueba UI bajo carga local. Se alineó el límite a 60 s, igual que la suite existente, y se ejecutó con un worker. Las aserciones funcionales se mantuvieron.

## Verificación visual

Browser local: ADE e IDE a 1440×900 y 1280×800; Mobile a 390×844 y 360×800.
Se inspeccionaron Workspace, inspector/contexto, revisión en IDE, Attention Mobile, decisión de riesgo alto y lista de trabajo agrupada.
Escape cierra Context; control confirma aria-expanded false. Foco visible implementado y retorno de foco previsto en cierre.
Se corrigieron recortes de tira de Attempts, contenedor Mobile y compositor tras inspección.
Capturas: C:\Users\USUARIO\.codex\visualizations\2026\10\13\01a136a1-c94f-7792-9d10-14b8ed6742c6\lixbon-ade.png, lixbon-ide.png, lixbon-mobile.png, lixbon-mobile-decision.png, lixbon-mobile-work.png, lixbon-ade-details-1280.png.
Regla reduced motion revisada en CSS; no se emuló esa preferencia en el navegador. No se afirma cumplimiento WCAG completo.

## Revisión independiente

Revisor de solo lectura contrastó código y baseline. Identificó estado local de revisión que se perdía al desmontar, cierre del atajo sobre selección inicial, estado de edición/revisión persistente en CLI, filtro de ronda siguiente y visibilidad de política. Todos corregidos; navegación y nuevas rondas tienen pruebas de regresión. El revisor no ejecutó pruebas ni navegador; esos resultados son del implementador.

## Límites

Todas las entidades, logs, comprobaciones, permisos, hosts y decisiones mostradas son simulados. No se probó ni modificó Core real, proveedores, persistencia, producción, Git integration real o Mobile nativo. El showcase conserva rutas de la maqueta anterior para compatibilidad. No hubo commit, push, merge o publicación.
