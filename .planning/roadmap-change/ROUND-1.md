# Lote 1 — tres encargos breves

**Estado:** desgloses completados. Tres agentes en total: Codex coordinador, Claude y OpenCode. Trabajo documental timeboxed; no hubo cambios de código ni ejecución de pruebas.

| Agente | Encargo del lote | Resultado |
|---|---|---|
| Claude | Dividir 01-01-01 (BASE-01) | `.planning/roadmap-change/CLAUDE-15M-01-01.md` en el worktree hijo |
| OpenCode | Dividir 01-04-02 (BASE-04) | `.planning/roadmap-change/OPENCODE-15M-01-04.md` en el worktree hijo |
| Codex | Dividir 01-03 (BASE-03) | `.planning/roadmap-change/CODEX-15M-01-03.md` en el checkout principal |

## Revisión del límite de 15 minutos

Los informes son propuestas de planificación; sus tiempos todavía no están medidos. Algunas subdivisiones siguen incluyendo demasiado trabajo para una sesión de 15 minutos:

- Claude M1 combina cinco paquetes, transitivas, hashes y procedencia; M2 agrupa varios rechazos inducidos; M3 cubre preflight, freshness y reconstrucción.
- OpenCode M1 agrupa startup y streaming; M2 agrupa cancelación, shell y varias condiciones de medición; M3 reparte trabajo entre tres artefactos y varios gates.
- Los encargos de Codex son más acotados, pero BASE-03b/c deben parar ante un inventario amplio o discrepancias múltiples.

Antes de ejecutar implementación, cortar esas unidades para que cada una produzca un único resultado verificable en 15 minutos; al llegar al límite, conservar el estado parcial y abrir otra tarea. No asumir que las estimaciones declaradas ya están validadas.

## Siguiente ola sugerida

Afinar solo el primer paso de BASE-01 hasta una única tarea real de ≤15 minutos y usarla como piloto de cuota. Mantener las fuentes GSD intactas hasta aprobar el nuevo desglose completo de Phase 1.
