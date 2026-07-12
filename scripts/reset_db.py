"""
reset_db.py — Vacía datos de la BD (Postgres) de forma controlada y segura.

Uso (en Railway, que inyecta DATABASE_URL):

    railway run python scripts/reset_db.py --scope billing        # ver qué borraría
    railway run python scripts/reset_db.py --scope billing --yes  # ejecutar

Alcances (--scope):
  billing  (recomendado)  Facturación y uso: credit_ledger, credit_accounts,
                          usage_quotas, token_usage_daily, subscriptions.
                          CONSERVA cuentas, API keys, nodos, planes y tarifas.
  history                 Lo de 'billing' + historial de chat (conversations,
                          messages), auditoría y embeddings.
  all                     Vaciado total de datos: lo anterior + cuentas
                          (users, sessions, api_keys) + nodos GPU.
                          La config (planes/tarifas/packs) se vuelve a sembrar
                          sola al reiniciar; la cuenta admin y el nodo GPU NO:
                          tendrás que registrarte y re-registrar el nodo.

Sin --yes solo muestra el conteo de filas (dry-run). Nunca toca el esquema:
solo TRUNCATE ... RESTART IDENTITY CASCADE sobre las tablas del alcance.
"""
from __future__ import annotations

import argparse
import sys

from sqlalchemy import text

from core.persistence.database import get_engine

BILLING = ["credit_ledger", "credit_accounts", "usage_quotas",
           "token_usage_daily", "subscriptions"]
HISTORY = ["messages", "conversations", "audit_events", "task_embeddings"]
ACCOUNTS = ["email_tokens", "sessions", "api_keys", "users"]
NODES = ["nodes"]

SCOPES = {
    "billing": BILLING,
    "history": BILLING + HISTORY,
    "all": BILLING + HISTORY + ACCOUNTS + NODES,
}

# Config que se re-siembra sola en init_db() — nunca la tocamos aquí.
KEEP_ALWAYS = ["plans", "model_pricing", "credit_packs", "app_versions"]


def main() -> int:
    ap = argparse.ArgumentParser(description="Vacía datos de la BD por alcance.")
    ap.add_argument("--scope", choices=SCOPES, default="billing")
    ap.add_argument("--yes", action="store_true", help="Ejecuta el borrado (sin esto, dry-run).")
    args = ap.parse_args()

    tables = SCOPES[args.scope]
    engine = get_engine()

    print(f"Alcance: {args.scope}")
    print(f"Se conservan siempre (config auto-sembrada): {', '.join(KEEP_ALWAYS)}\n")
    print("Tabla                     Filas actuales")
    print("-" * 42)
    total = 0
    with engine.connect() as conn:
        for t in tables:
            try:
                n = conn.execute(text(f"SELECT count(*) FROM {t}")).scalar() or 0
            except Exception as exc:
                print(f"{t:<25} (no existe: {exc})")
                continue
            total += n
            print(f"{t:<25} {n:>12,}")
    print("-" * 42)
    print(f"{'TOTAL':<25} {total:>12,}\n")

    if not args.yes:
        print("DRY-RUN. Nada borrado. Vuelve a ejecutar con --yes para vaciar estas tablas.")
        return 0

    with engine.begin() as conn:
        # TRUNCATE en un solo comando: CASCADE resuelve las FKs; RESTART IDENTITY
        # reinicia los autoincrement para empezar desde 1.
        conn.execute(text(
            f"TRUNCATE TABLE {', '.join(tables)} RESTART IDENTITY CASCADE"
        ))
    print(f"Listo. {len(tables)} tabla(s) vaciada(s), {total:,} filas eliminadas.")
    if args.scope == "all":
        print("\nRecuerda: re-regístrate con tu correo admin (se promueve solo por "
              "ADMIN_EMAILS al reiniciar) y vuelve a registrar el nodo GPU en el panel.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
