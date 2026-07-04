# Seeds

Datos iniciales que se cargan una vez por entorno.

| Archivo | Fase | Contenido |
|---|---|---|
| `plans.sql` | F5 | Los 3 planes: Gratuito, Pro, Advance con sus límites |
| `admin.sql` | F3 | Marca tu usuario como `role=admin` |

Las tablas `plans` y la columna `role` llegan con las fases F5 y F3 respectivamente;
los seeds se crean junto con sus migraciones.
