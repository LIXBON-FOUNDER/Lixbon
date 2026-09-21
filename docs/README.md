# Documentación de lixbon

## Empezar por aquí

| Documento | Para qué |
|---|---|
| [ARQUITECTURA.md](ARQUITECTURA.md) | Mapa del monorepo, componentes, contratos entre gateway y apps, despliegue |
| [RAMAS_Y_RELEASES.md](RAMAS_Y_RELEASES.md) | Modelo de ramas (`master` / `desktop` / `cli` / `mobile`), convención de commits, cómo publicar cada producto |
| [ESTADO_ACTUAL.md](ESTADO_ACTUAL.md) | Estado del proyecto para retomar el trabajo |
| [../PRODUCT.md](../PRODUCT.md) | Brief de producto: usuarios, personalidad de marca, principios de diseño |

## Diseño

| Documento | Para qué |
|---|---|
| [DISENO_WEB.md](DISENO_WEB.md) | Especificación visual de lixbon.com; los tokens de `apps/web/src/styles/base.css` son la fuente de verdad para todas las apps |
| [PLAN_UX_FASES.md](PLAN_UX_FASES.md) | Identidad y funciones del CLI y el desktop, por fases |
| [../assets/brand/](../assets/brand/README.txt) | Iconos y favicon oficiales |

## Diseño técnico y decisiones

| Documento | Para qué |
|---|---|
| [LIMITES_DE_USO.md](LIMITES_DE_USO.md) | Modelo de límites sesión (5h) + semanal compartido entre clientes y cómo está implementado |
| [CUELLO_DE_BOTELLA_MODELOS.md](CUELLO_DE_BOTELLA_MODELOS.md) | Por qué hay un modelo por rol de inferencia (chat, fim, vision, embed, route) |
| [PLAN_REMOTE.md](PLAN_REMOTE.md) | Protocolo `/remote`: control de sesiones CLI/desktop desde el móvil |
| [PLAN_IDE.md](PLAN_IDE.md) | Plan de evolución del desktop |
| [VERIFICACION_IDE.md](VERIFICACION_IDE.md) | Checklist de verificación manual del desktop |

## Histórico

| Documento | Para qué |
|---|---|
| [PLAN_MAESTRO.md](PLAN_MAESTRO.md) | Plan de ejecución original de LAN a SaaS (2026-07) |
| [INFORME_Y_PLAN.md](INFORME_Y_PLAN.md) | Diagnóstico técnico original (2026-07); las rutas que cita ya no existen |

## Documentación por app

Cada app tiene su README con desarrollo local, estructura y release:
[`apps/web`](../apps/web/README.md) · [`apps/desktop`](../apps/desktop/README.md) ·
[`apps/cli`](../apps/cli/README.md) · [`apps/mobile`](../apps/mobile/README.md).

## Convenciones

- Idioma: español, tanto en docs como en commits y UI.
- Fecha de vigencia al principio de cada documento de plan/estado (`> Actualizado: AAAA-MM-DD`).
- Comentarios en código solo para decisiones no evidentes, workarounds y reglas de negocio (`.claude/claude.md`).
