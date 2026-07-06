# Backups de la base de datos (Railway Postgres)

## Backup manual desde tu PC

Con el cliente `pg_dump` instalado (viene con Postgres; en Windows puedes instalar solo las herramientas cliente):

```bash
# Staging
pg_dump "$DATABASE_URL_STAGING" --format=custom --file=backup-staging-$(date +%Y%m%d).dump

# Producción (usa la URL pública desde las variables del servicio en Railway)
pg_dump "$DATABASE_URL_PROD" --format=custom --file=backup-prod-$(date +%Y%m%d).dump
```

## Restaurar

```bash
pg_restore --clean --no-owner --dbname="$DATABASE_URL_DESTINO" backup-prod-YYYYMMDD.dump
```

## Backups automáticos de Railway

Railway hace backups automáticos de los servicios Postgres (según plan).
Verifica en: proyecto → servicio Postgres → pestaña **Backups**.
Antes de cualquier migración de Alembic en prod: backup manual primero.

## Regla de oro

1. Toda migración se aplica primero en `lixbon-staging`.
2. Backup manual de prod ANTES de aplicar la misma migración en prod.
3. Nunca ejecutar `reset_staging.py` con la URL de prod (el script se niega si `lixbon_ENV=production`, pero no te confíes solo de eso).
