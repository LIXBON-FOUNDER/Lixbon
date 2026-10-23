# Documentación de lixbon

## Empezar

| Documento | Para qué |
|---|---|
| [`README.md`](../README.md) | Qué es lixbon, arranque rápido, API y despliegue |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | Ramas, commits, PRs y cómo publicar cada producto |
| [`SECURITY.md`](../SECURITY.md) | Cómo reportar una vulnerabilidad |
| [`PRODUCT.md`](../PRODUCT.md) | Brief de producto y principios de diseño |

## Arquitectura

| Documento | Para qué |
|---|---|
| [`ARQUITECTURA.md`](ARQUITECTURA.md) | Componentes, routers, nodos y contratos gateway↔apps |
| [`RESUMEN_PROYECTO.md`](RESUMEN_PROYECTO.md) | Foto del proyecto y deuda conocida |
| [`VOCABULARIO.md`](VOCABULARIO.md) | Nombres canónicos de estados ([`contracts/status-vocabulary.json`](../contracts/status-vocabulary.json)) |

## Core del orquestador (desktop)

| Documento | Para qué |
|---|---|
| [`core/AUTORIDAD.md`](core/AUTORIDAD.md) | Quién es la fuente de verdad de cada dato |
| [`core/EVENTOS.md`](core/EVENTOS.md) | Event Log |
| [`core/MIGRACIONES.md`](core/MIGRACIONES.md) | Migraciones de la base local |
| [`core/PROYECTOS.md`](core/PROYECTOS.md) | Registro de proyectos |
| [`core/QUERIES.md`](core/QUERIES.md) | Queries de solo lectura para clientes (overview multiproyecto) |
| [`core/ACTIVITY.md`](core/ACTIVITY.md) | Activity humana: proyección del Event Log para clientes (claves de mensaje) |
| [`core/RESOURCES.md`](core/RESOURCES.md) | Inventario de worktrees, ramas y recursos huérfanos (solo lectura) |
| [`core/CORTE_TASK_ATTEMPT.md`](core/CORTE_TASK_ATTEMPT.md) | ADR F3: corte Task/Attempt, mapping del legado, compatibilidad F2 y rollback por copia |
| [`core/TASKS.md`](core/TASKS.md) | Task como intención durable: esquema, mutadores y Events (inerte hasta el corte) |
| [`core/ATTEMPTS.md`](core/ATTEMPTS.md) | Attempt como ejecución concreta: esquema, ciclo de vida cerrado, mutadores y Events (inerte hasta el corte) |
| [`core/RUNTIME_TABLAS.md`](core/RUNTIME_TABLAS.md) | El runtime persiste y carga su estado desde las tablas Task/Attempt tras el corte (LXO-232) |
| [`secure-store/README.md`](secure-store/README.md) | Almacén seguro de credenciales |

## Operación

| Documento | Para qué |
|---|---|
| [`INCIDENTES.md`](INCIDENTES.md) | Incidentes en producción y su causa |
| [`db/scripts/backup.md`](../db/scripts/backup.md) | Copias de seguridad de Postgres |
| [`infra/render_worker/README.md`](../infra/render_worker/README.md) | Worker de render de los Visuals |

## Por app

[`apps/web`](../apps/web/README.md) ·
[`apps/desktop`](../apps/desktop/README.md) ·
[`apps/cli`](../apps/cli/README.md) ([CHANGELOG](../apps/cli/CHANGELOG.md)) ·
[`apps/mobile`](../apps/mobile/README.md)
