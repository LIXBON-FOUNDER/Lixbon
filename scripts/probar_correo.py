"""
probar_correo.py — Responde a «¿por qué no llegan los correos?» con datos, no
con suposiciones. No toca la base de datos ni crea cuentas.

Uso (en Railway, que inyecta las variables de producción):

    railway run python scripts/probar_correo.py                    # solo diagnóstico
    railway run python scripts/probar_correo.py tu@correo.com      # + envía una prueba
    railway run python scripts/probar_correo.py tu@correo.com --plantilla bienvenida

Comprueba, en este orden:

  1. Las variables del gateway (BREVO_API_KEY, EMAIL_FROM, PUBLIC_BASE_URL).
  2. Que la clave vale, preguntándole a Brevo por la cuenta.
  3. Que el REMITENTE exacto está dado de alta y validado. Sin esto, el relay
     contesta «the sender you used is not valid» y no sale ni un correo.
  4. Que el DOMINIO del remitente está autenticado (SPF+DKIM). Sin esto los
     correos salen, pero con muchas papeletas de acabar en spam.
  5. Si se le pasa un destinatario, envía uno de los ocho correos de verdad y
     enseña la respuesta cruda de Brevo, incluido el motivo de un rechazo.
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# La consola de Windows no habla UTF-8 por defecto y este informe va lleno de
# acentos: sin esto, el diagnóstico se lee peor que el problema que diagnostica.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import httpx

from core.gateway import email as correo
from core.gateway import email_templates as plantillas

PLANTILLAS = ("verificacion", "bienvenida", "acceso", "suscripcion", "reset",
              "password", "cancelacion", "pago")

PLAN_DE_MUESTRA = {
    "name": "Pro", "price_monthly_cents": 1900, "messages_per_day": 500,
    "tokens_per_month": 2000000, "max_api_keys": 5, "rate_limit_per_min": 120,
}

UA_DE_MUESTRA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                 "Chrome/141.0.0.0 Safari/537.36")


def linea(marca: str, texto: str) -> None:
    print(f"  [{marca}] {texto}")


def cabecera(texto: str) -> None:
    print(f"\n{texto}\n{'-' * len(texto)}")


def _oculta(clave: str) -> str:
    if len(clave) <= 14:
        return "(sospechosamente corta)"
    return f"{clave[:8]}...{clave[-4:]} ({len(clave)} caracteres)"


def revisar_variables() -> bool:
    cabecera("1. Variables del gateway")
    ok = True
    if correo.BREVO_API_KEY:
        linea("ok", f"BREVO_API_KEY = {_oculta(correo.BREVO_API_KEY)}")
    else:
        linea("!!", "BREVO_API_KEY está VACÍA. Sin ella no sale ni un correo: en "
                    "producción se pierden, en local se escriben en el log.")
        ok = False

    remitente = correo._remitente()
    linea("ok", f"EMAIL_FROM = {remitente['name']} <{remitente['email']}>")

    base = correo.PUBLIC_BASE_URL
    if base.startswith("https://"):
        linea("ok", f"PUBLIC_BASE_URL = {base}")
    else:
        linea("!!", f"PUBLIC_BASE_URL = {base} — los enlaces de verificación que "
                    "lleven los correos no funcionarán fuera de este equipo.")
        ok = False
    return ok


def revisar_cuenta(cliente: httpx.Client) -> bool:
    cabecera("2. La clave, según Brevo")
    try:
        resp = cliente.get("https://api.brevo.com/v3/account")
    except Exception as exc:
        linea("!!", f"No se pudo hablar con Brevo: {exc}")
        return False
    if resp.status_code == 401:
        linea("!!", "Brevo dice que la clave no vale (401). Genera otra en "
                    "Brevo -> SMTP & API -> API keys.")
        return False
    if resp.status_code != 200:
        linea("!!", f"Brevo respondió {resp.status_code}: {resp.text[:200]}")
        return False
    datos = resp.json()
    linea("ok", f"Cuenta: {datos.get('email', '?')} — {datos.get('companyName') or 'sin empresa'}")
    return True


def revisar_remitente(cliente: httpx.Client) -> bool:
    """El remitente exacto, dado de alta y validado en Brevo.

    Es el error literal que devuelve el relay cuando falta: «Sending has been
    rejected because the sender you used ... is not valid»."""
    cabecera("3. El remitente, dado de alta en Brevo")
    direccion = correo._remitente()["email"].lower()
    try:
        resp = cliente.get("https://api.brevo.com/v3/senders")
    except Exception as exc:
        linea("!!", f"No se pudo consultar los remitentes: {exc}")
        return False
    if resp.status_code != 200:
        linea("!!", f"Brevo respondió {resp.status_code}: {resp.text[:200]}")
        return False

    remitentes = resp.json().get("senders") or []
    encontrado = next((r for r in remitentes
                       if str(r.get("email") or "").lower() == direccion), None)
    if not encontrado:
        linea("!!", f"«{direccion}» NO está dado de alta como remitente. Brevo "
                    "rechaza cada envío con «the sender you used is not valid».")
        if remitentes:
            linea("--", "Los que sí están: "
                        + ", ".join(str(r.get("email")) for r in remitentes))
        linea("--", "Alta en Brevo -> Senders, Domains & Dedicated IPs -> Senders. "
                    "Brevo manda un código a esa dirección: con el reenvío de "
                    "Cloudflare Email Routing llega al buzón de destino.")
        return False
    if encontrado.get("active"):
        linea("ok", f"«{direccion}» está dado de alta y validado.")
        return True
    linea("!!", f"«{direccion}» está dado de alta pero SIN validar: Brevo envió un "
                "código a esa dirección y nadie lo confirmó todavía.")
    return False


def revisar_dominio(cliente: httpx.Client) -> bool:
    cabecera("4. El dominio del remitente, autenticado en Brevo")
    dominio = correo._remitente()["email"].split("@")[-1].lower()
    try:
        resp = cliente.get("https://api.brevo.com/v3/senders/domains")
    except Exception as exc:
        linea("!!", f"No se pudo consultar los dominios: {exc}")
        return False
    if resp.status_code != 200:
        linea("!!", f"Brevo respondió {resp.status_code}: {resp.text[:200]}")
        return False

    dominios = resp.json().get("domains") or []
    nombre_de = lambda d: str(d.get("domain_name") or d.get("domain") or "").lower()
    encontrado = next((d for d in dominios if nombre_de(d) == dominio), None)

    if not encontrado:
        linea("!!", f"«{dominio}» NO está dado de alta en Brevo. Cualquier envío "
                    f"desde {correo._remitente()['email']} será rechazado.")
        if dominios:
            linea("--", "Los que sí están: " + ", ".join(nombre_de(d) for d in dominios))
        linea("--", "Alta en Brevo -> Senders, Domains & Dedicated IPs -> Domains.")
        return False

    if encontrado.get("authenticated"):
        linea("ok", f"«{dominio}» está autenticado (SPF y DKIM correctos).")
        return True

    linea("!!", f"«{dominio}» está dado de alta pero SIN autenticar: le faltan sus "
                "registros DNS. Brevo rechaza los envíos, o acaban en spam.")
    linea("--", "Copia los registros que da Brevo y añádelos en Cloudflare DNS. "
                "El SPF hay que FUSIONARLO con el que ya existe: dos registros "
                "SPF en un dominio lo invalidan entero.")
    return False


def construir(plantilla: str) -> tuple[str, str, str]:
    base = correo.PUBLIC_BASE_URL
    if plantilla == "verificacion":
        return plantillas.verificacion(f"{base}/api/auth/verify-email?token=PRUEBA")
    if plantilla == "bienvenida":
        return plantillas.bienvenida(
            plan_nombre="Gratuito",
            plan_limites=" · ".join(correo.limites_de_plan(PLAN_DE_MUESTRA)[:3]),
            url=base,
            url_planes=f"{base}/planes",
        )
    if plantilla == "password":
        return plantillas.password_cambiada(
            cuando=correo.momento_largo(),
            dispositivo=correo.describir_dispositivo(UA_DE_MUESTRA),
            ip=correo.recortar_ip("190.24.18.77"),
            url_recuperar=f"{base}/reset-password",
        )
    if plantilla == "cancelacion":
        return plantillas.suscripcion_cancelada(
            plan_nombre=PLAN_DE_MUESTRA["name"],
            limites_gratis=["30 mensajes al día", "150 000 tokens al mes", "1 clave de API"],
            url_planes=f"{base}/planes",
        )
    if plantilla == "pago":
        return plantillas.pago_fallido(
            plan_nombre=PLAN_DE_MUESTRA["name"],
            importe=correo.importe_de_factura(PLAN_DE_MUESTRA["price_monthly_cents"], "usd"),
            reintento=correo.fecha_larga("2026-09-03T10:00:00Z"),
            url_pago=f"{base}/account/facturacion",
        )
    if plantilla == "reset":
        return plantillas.reset_password(f"{base}/reset-password?token=PRUEBA")
    if plantilla == "acceso":
        return plantillas.acceso(
            cuando=correo.momento_largo(),
            dispositivo=correo.describir_dispositivo(UA_DE_MUESTRA),
            ip=correo.recortar_ip("190.24.18.77"),
            url_proteger=f"{base}/reset-password",
        )
    return plantillas.suscripcion(
        plan_nombre=PLAN_DE_MUESTRA["name"],
        precio=correo._precio(PLAN_DE_MUESTRA),
        limites=correo.limites_de_plan(PLAN_DE_MUESTRA),
        renovacion=correo.fecha_larga("2026-09-30T00:00:00Z"),
        url=f"{base}/cuenta",
    )


def enviar(cliente: httpx.Client, destino: str, plantilla: str) -> bool:
    cabecera(f"5. Envío de prueba a {destino} (plantilla: {plantilla})")
    asunto, html, texto = construir(plantilla)
    linea("--", f"Asunto: {asunto}")
    try:
        resp = cliente.post(correo.BREVO_URL, json={
            "sender": correo._remitente(),
            "to": [{"email": destino}],
            "subject": f"[prueba] {asunto}",
            "htmlContent": html,
            "textContent": texto,
        })
    except Exception as exc:
        linea("!!", f"El envío ni siquiera salió: {exc}")
        return False

    if resp.status_code in (200, 201, 202):
        linea("ok", f"Brevo lo aceptó: {resp.text[:200]}")
        linea("--", "Aceptado no es entregado: mira también la carpeta de spam y "
                    "el registro de Brevo -> Transactional -> Logs.")
        return True
    linea("!!", f"Brevo lo RECHAZÓ ({resp.status_code}): {resp.text[:400]}")
    return False


def main() -> int:
    partes = argparse.ArgumentParser(description="Diagnostica el correo transaccional de lixbon.")
    partes.add_argument("destino", nargs="?", help="Dirección a la que mandar el correo de prueba")
    partes.add_argument("--plantilla", choices=PLANTILLAS, default="verificacion",
                        help="Cuál de los ocho correos enviar (por defecto: verificacion)")
    args = partes.parse_args()

    print("Diagnóstico del correo transaccional de lixbon")
    todo_bien = revisar_variables()

    # Sin clave no hay nada que preguntarle a Brevo: el resto de comprobaciones
    # solo repetirían el mismo 401.
    if not correo.BREVO_API_KEY:
        print("\nSin BREVO_API_KEY no hay más que comprobar: configúrala primero.")
        return 1

    with httpx.Client(timeout=20.0, headers={
        "api-key": correo.BREVO_API_KEY,
        "accept": "application/json",
        "content-type": "application/json",
    }) as cliente:
        todo_bien = revisar_cuenta(cliente) and todo_bien
        todo_bien = revisar_remitente(cliente) and todo_bien
        todo_bien = revisar_dominio(cliente) and todo_bien
        if args.destino:
            todo_bien = enviar(cliente, args.destino, args.plantilla) and todo_bien
        else:
            cabecera("5. Envío de prueba")
            linea("--", "No se pidió: pásale una dirección para enviar uno de verdad.")

    print()
    print("Todo en orden." if todo_bien
          else "Hay algo que arreglar: arriba están las marcas [!!].")
    return 0 if todo_bien else 1


if __name__ == "__main__":
    raise SystemExit(main())
