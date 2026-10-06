# Phase 1: Contratos y línea base reproducible — Context

Fecha: 2026-10-05. Contexto derivado de la petición del usuario y del debate realizado en Orca.

## Phase Boundary

Producir una referencia Python reproducible, un inventario contractual y un corpus portable, definir destinos/dependencias soportados y establecer escenarios y criterios de comparación. No empezar la reescritura Go en esta fase; el primer chat Go utilizable pertenece a Phase 2.

## Decisions

- Go elegido por el usuario para entregar binarios sin Python/pip; véase `.planning/DECISION-CLI-GO.md`.
- Mantener Python como referencia y recuperación hasta aceptar paridad y distribución.
- Corpus portable independiente de implementaciones para payloads, SSE, tool calls, errores, limpieza y cancelación. Registrar diferencias entre Python y desktop, sin convertir comportamiento accidental en contrato silenciosamente.
- Preservar fuentes en `apps/cli/audit/`; los nuevos resultados vivirán en un directorio nuevo de migración o validación. El resultado histórico 131/2 no es un PASS de esta fase.
- Separar contratos de la API, comportamiento de terminal, política de permisos y recursos; la fixture de parsing no demuestra que la terminal real funcione.
- Orca coordina futuros worktrees y terminales. Cada plan debe tener dueño de archivos, dependencias y revisión independiente. Los worktrees del debate se conservan.
- Experimento Rust opcional y fuera del camino crítico; sin responsable/fecha desktop y criterios concretos queda diferido. No generar un plan obligatorio de Rust.
- No fijar biblioteca/versiones de UI/PDF basándose solo en lo nombrado por la evaluación. Phase 2 incluye pruebas acotadas antes del port completo.

## Open Choices to Resolve During Execution

- Matriz de OS/arquitectura/terminal y alcance de helpers por plataforma, basada en objetivos de distribución y evidencia disponible. La planificación no convierte destinos sin prueba en soportados.
- Política CGO y herramientas de extracción documental compatibles con la promesa de instalación.
- Presupuestos de arranque/RSS/streaming/cancelación a partir de mediciones reproducibles; no inventar umbrales universales ni mejoras de Go.
- Causa de los dos fallos de fixture y cómo reparar el entorno/referencia sin esconder fallos o modificar contratos para pasar pruebas.
- Discrepancia README frente a instalación de rich/prompt_toolkit/pypdf: inventariar y corregir documentación futura con evidencia.

## Source Context

- `apps/cli/audit/EVALUACION_PYTHON_GO.md` y `.planning/intel/SYNTHESIS.md`.
- `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`.
- `.planning/DECISION-CLI-GO.md`: perspectivas Claude, OpenCode, usuario y Codex y resultados del debate.

## Deferred Ideas

Compartir implementación Rust con desktop, OCR y migración del backend quedan fuera del hito principal. Almacén de credenciales del OS es una mejora posterior separada de la elección del lenguaje.
