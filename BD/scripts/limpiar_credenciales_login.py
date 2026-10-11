"""
limpiar_credenciales_login.py — Retira las API keys que emitía el login antes de
las sesiones de dispositivo (paso 8 de la separación sesiones / API keys).

Sin argumentos solo informa (transacción de solo lectura). Con --aplicar:
  - desactiva las keys origin='login' (las emitía cada login de las apps);
  - desactiva las origin='login_compat' sin uso en --dias días;
  - pasa a origin='manual' las login_compat que siguen en uso: alguien las
    tiene en una integración y se tratan como una key creada a mano.
Desactivar es reversible (is_active=0); el cron de archivado las archiva a los
30 días como cualquier otra key desactivada.

Informa también de las sesiones legacy vivas: mientras haya, quedan clientes
anteriores a desktop 2.0.29 / CLI 2.6.0 / móvil 0.5.0 y el camino legacy del
gateway no se puede retirar.

Uso:  python BD/scripts/limpiar_credenciales_login.py [--aplicar] [--dias 30]
Con DATABASE_PUBLIC_URL (p. ej. `railway run -s Lixbon-prod`) se usa esa en
lugar de DATABASE_URL, que dentro de Railway es una dirección interna.
"""
import argparse
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

if os.getenv("DATABASE_PUBLIC_URL"):
    os.environ["DATABASE_URL"] = os.environ["DATABASE_PUBLIC_URL"]
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy import text  # noqa: E402

from core.persistence.database import get_engine  # noqa: E402

RESUMEN = """
SELECT origin, name LIKE 'Default Key - %' OR name LIKE 'Session - %' AS compat,
       count(*) FILTER (WHERE is_active = 1) AS activas,
       count(*) FILTER (WHERE is_active = 1 AND last_accessed >= :desde) AS usadas,
       count(DISTINCT user_id) FILTER (WHERE is_active = 1) AS usuarios
FROM api_keys GROUP BY 1, 2 ORDER BY 1, 2
"""

SESIONES = """
SELECT client, legacy, count(*) AS vivas, count(*) FILTER (WHERE last_used_at >= :desde) AS usadas
FROM sessions
WHERE coalesce(refresh_expires_at, expires_at) >= :ahora
GROUP BY 1, 2 ORDER BY 1, 2
"""

DESACTIVAR = """
UPDATE api_keys SET is_active = 0, status = 'inactive', deactivated_at = :ahora
WHERE is_active = 1 AND (origin = 'login'
      OR (origin = 'login_compat' AND (last_accessed IS NULL OR last_accessed < :desde)))
"""

ADOPTAR = """
UPDATE api_keys SET origin = 'manual'
WHERE is_active = 1 AND origin = 'login_compat' AND last_accessed >= :desde
"""


def tabla(conn, sql, params):
    res = conn.execute(text(sql), params)
    cols = list(res.keys())
    filas = [[str(v) for v in r] for r in res]
    anchos = [max([len(c)] + [len(f[i]) for f in filas]) for i, c in enumerate(cols)]
    print("  " + " | ".join(c.ljust(w) for c, w in zip(cols, anchos)))
    for f in filas:
        print("  " + " | ".join(v.ljust(w) for v, w in zip(f, anchos)))
    if not filas:
        print("  (nada)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--aplicar", action="store_true", help="hace los cambios (sin esto, solo informa)")
    parser.add_argument("--dias", type=int, default=30, help="días sin uso para dar por muerta una key login_compat")
    args = parser.parse_args()

    ahora = datetime.now(timezone.utc)
    params = {"ahora": ahora.isoformat(), "desde": (ahora - timedelta(days=args.dias)).isoformat()}

    with get_engine().connect() as conn:
        if not args.aplicar:
            conn.execute(text("SET TRANSACTION READ ONLY"))
        print(f"API keys activas (usadas = en los últimos {args.dias} días):")
        tabla(conn, RESUMEN, params)
        print("\nSesiones vivas por cliente (legacy = clientes anteriores):")
        tabla(conn, SESIONES, params)
        if not args.aplicar:
            conn.rollback()
            print("\nSolo lectura. Con --aplicar se desactivan las keys login y las login_compat sin uso.")
            return
        desactivadas = conn.execute(text(DESACTIVAR), params).rowcount
        adoptadas = conn.execute(text(ADOPTAR), params).rowcount
        conn.commit()
        print(f"\nDesactivadas: {desactivadas}. Pasan a manual (siguen en uso): {adoptadas}.")


if __name__ == "__main__":
    main()
