from __future__ import annotations

import asyncio
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any, Awaitable

import httpx

from core.gateway import email_templates as plantillas

logger = logging.getLogger("lixbon.email")

BREVO_API_KEY = os.getenv("BREVO_API_KEY", "")
BREVO_URL = "https://api.brevo.com/v3/smtp/email"
EMAIL_FROM = os.getenv("EMAIL_FROM", "lixbon <no-reply@lixbon.com>")
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/")

_MESES = ("enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
          "agosto", "septiembre", "octubre", "noviembre", "diciembre")

# asyncio solo guarda referencias débiles a las tareas: sin este conjunto, un
# envío disparado desde código síncrono puede recolectarse a medio camino.
_EN_VUELO: set[asyncio.Task] = set()


def _remitente() -> dict[str, str]:
    encontrado = re.fullmatch(r"\s*(.*?)\s*<\s*(.+?)\s*>\s*", EMAIL_FROM)
    if encontrado:
        return {"name": encontrado.group(1) or "lixbon", "email": encontrado.group(2)}
    return {"name": "lixbon", "email": EMAIL_FROM.strip()}


def en_produccion() -> bool:
    # El gateway de verdad se sirve por HTTPS; el de desarrollo, por
    # http://localhost. Sirve para no tratar como «modo dev» a un despliegue al
    # que sencillamente se le olvidó la clave.
    return PUBLIC_BASE_URL.startswith("https://")


def problema_de_configuracion() -> str | None:
    """El motivo por el que un correo enviado ahora no llegaría, o None.

    No comprueba el DNS: eso solo lo sabe Brevo al recibir el envío. Detecta lo
    que sí se puede ver desde aquí, que es lo que más veces ha fallado."""
    if not BREVO_API_KEY:
        return ("BREVO_API_KEY está vacía: ningún correo sale de aquí "
                "(verificación, bienvenida, aviso de acceso ni suscripción).")
    if not _remitente()["email"] or "@" not in _remitente()["email"]:
        return f"EMAIL_FROM no tiene una dirección utilizable: {EMAIL_FROM!r}"
    if not PUBLIC_BASE_URL or "localhost" in PUBLIC_BASE_URL or "127.0.0.1" in PUBLIC_BASE_URL:
        return (f"PUBLIC_BASE_URL apunta a {PUBLIC_BASE_URL}: los correos saldrían, "
                "pero sus enlaces de verificación no funcionarían fuera de este equipo.")
    return None


async def send_email(to: str, subject: str, html: str, text: str = "") -> bool:
    if not to:
        return False
    if not BREVO_API_KEY:
        # En producción esto no es un modo de trabajo, es un correo perdido: se
        # devuelve False para que quien llame pueda contarlo en vez de dar por
        # enviado algo que nadie recibió.
        if en_produccion():
            logger.error(f"Correo NO enviado a {to} ({subject}): falta BREVO_API_KEY.")
            return False
        logger.warning(f"[email-dev] Para: {to} | Asunto: {subject}")
        logger.warning(f"[email-dev] Texto: {text or '(solo HTML)'}")
        return True

    cuerpo: dict[str, Any] = {
        "sender": _remitente(),
        "to": [{"email": to}],
        "subject": subject,
        "htmlContent": html,
    }
    if text:
        cuerpo["textContent"] = text

    try:
        async with httpx.AsyncClient(timeout=15.0) as cliente:
            resp = await cliente.post(
                BREVO_URL,
                headers={
                    "api-key": BREVO_API_KEY,
                    "accept": "application/json",
                    "content-type": "application/json",
                },
                json=cuerpo,
            )
            resp.raise_for_status()
        return True
    except httpx.HTTPStatusError as exc:
        logger.error(f"Brevo rechazó el envío a {to}: "
                     f"{exc.response.status_code} {exc.response.text[:300]}")
        return False
    except Exception as exc:
        logger.error(f"No se pudo enviar correo a {to}: {exc}")
        return False


def en_segundo_plano(envio: Awaitable[bool]) -> None:
    # Para llamar desde código síncrono (el webhook de Stripe) sin bloquearlo
    # ni dejar que una caída del correo tumbe la operación de negocio.
    try:
        bucle = asyncio.get_running_loop()
    except RuntimeError:
        asyncio.run(_tragando_errores(envio))
        return
    tarea = bucle.create_task(_tragando_errores(envio))
    _EN_VUELO.add(tarea)
    tarea.add_done_callback(_EN_VUELO.discard)


async def _tragando_errores(envio: Awaitable[bool]) -> None:
    try:
        await envio
    except Exception as exc:
        logger.error(f"Envío en segundo plano fallido: {exc}")


# ── Datos que los correos necesitan ────────────────────────────────────────

def fecha_larga(iso: str | None) -> str | None:
    if not iso:
        return None
    try:
        momento = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    return f"{momento.day} de {_MESES[momento.month - 1]} de {momento.year}"


def momento_largo(cuando: datetime | None = None) -> str:
    momento = (cuando or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return (f"{momento.day} de {_MESES[momento.month - 1]} de {momento.year}, "
            f"{momento:%H:%M} (UTC)")


def describir_dispositivo(user_agent: str | None) -> str:
    ua = user_agent or ""
    if not ua.strip():
        return "Un dispositivo sin identificar"
    if "lixbon" in ua.lower():
        return "Una aplicación de lixbon"

    navegador = ""
    # El orden importa: Edge y Opera se anuncian también como Chrome, y Chrome
    # como Safari.
    for marca, nombre in (("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"),
                          ("Chrome/", "Chrome"), ("Safari/", "Safari")):
        if marca in ua:
            navegador = nombre
            break

    sistema = ""
    for marca, nombre in (("Windows", "Windows"), ("Android", "Android"),
                          ("iPhone", "iOS"), ("iPad", "iPadOS"),
                          ("Mac OS X", "macOS"), ("Linux", "Linux")):
        if marca in ua:
            sistema = nombre
            break

    if navegador and sistema:
        return f"{navegador} en {sistema}"
    return navegador or sistema or "Un dispositivo sin identificar"


def recortar_ip(ip: str | None) -> str:
    # Basta para reconocer la propia red sin dejar la dirección entera en un
    # buzón que puede acabar reenviado.
    if not ip:
        return "desconocida"
    if ":" in ip:
        tramos = ip.split(":")
        return ":".join(tramos[:4] + ["•••"]) if len(tramos) > 4 else ip
    tramos = ip.split(".")
    if len(tramos) == 4:
        return ".".join(tramos[:3] + ["•••"])
    return ip


def _precio(plan: dict[str, Any]) -> str:
    centavos = plan.get("price_monthly_cents") or 0
    return f"${centavos / 100:.2f}"


def limites_de_plan(plan: dict[str, Any]) -> list[str]:
    def miles(n: int) -> str:
        return f"{n:,}".replace(",", " ")

    mensajes = plan.get("messages_per_day")
    tokens = plan.get("tokens_per_month")
    llaves = plan.get("max_api_keys")
    ritmo = plan.get("rate_limit_per_min")

    limites: list[str] = []
    if mensajes is not None:
        limites.append("Mensajes sin límite diario" if mensajes < 0
                       else f"{miles(mensajes)} mensajes al día")
    if tokens is not None:
        limites.append(f"{miles(tokens)} tokens al mes")
    if llaves is not None:
        limites.append(f"{llaves} clave{'s' if llaves != 1 else ''} de API")
    if ritmo is not None:
        limites.append(f"{ritmo} peticiones por minuto")
    return limites


# ── Los correos ────────────────────────────────────────────────────────────

async def send_verification_email(to: str, token: str) -> bool:
    url = f"{PUBLIC_BASE_URL}/api/auth/verify-email?token={token}"
    asunto, html, texto = plantillas.verificacion(url)
    return await send_email(to, asunto, html, texto)


async def send_password_reset_email(to: str, token: str) -> bool:
    url = f"{PUBLIC_BASE_URL}/reset-password?token={token}"
    asunto, html, texto = plantillas.reset_password(url)
    return await send_email(to, asunto, html, texto)


async def send_welcome_email(to: str, plan: dict[str, Any] | None = None) -> bool:
    limites = limites_de_plan(plan or {})[:3]
    asunto, html, texto = plantillas.bienvenida(
        plan_nombre=(plan or {}).get("name") or "Gratuito",
        plan_limites=" · ".join(limites) or "Empieza a usarlo cuando quieras",
        url=PUBLIC_BASE_URL,
        url_planes=f"{PUBLIC_BASE_URL}/planes",
    )
    return await send_email(to, asunto, html, texto)


async def send_login_alert_email(to: str, *, user_agent: str | None,
                                 ip: str | None, cuando: datetime | None = None) -> bool:
    asunto, html, texto = plantillas.acceso(
        cuando=momento_largo(cuando),
        dispositivo=describir_dispositivo(user_agent),
        ip=recortar_ip(ip),
        url_proteger=f"{PUBLIC_BASE_URL}/reset-password",
    )
    return await send_email(to, asunto, html, texto)


async def send_subscription_email(to: str, plan: dict[str, Any],
                                  renovacion_iso: str | None = None) -> bool:
    asunto, html, texto = plantillas.suscripcion(
        plan_nombre=plan.get("name") or "de pago",
        precio=_precio(plan),
        limites=limites_de_plan(plan),
        renovacion=fecha_larga(renovacion_iso),
        url=f"{PUBLIC_BASE_URL}/account",
    )
    return await send_email(to, asunto, html, texto)


async def send_password_changed_email(to: str, *, user_agent: str | None, ip: str | None,
                                      cuando: datetime | None = None) -> bool:
    asunto, html, texto = plantillas.password_cambiada(
        cuando=momento_largo(cuando),
        dispositivo=describir_dispositivo(user_agent),
        ip=recortar_ip(ip),
        # El mismo camino que usó quien cambió la contraseña sirve para
        # recuperarla: si no fue el dueño, es justo lo que necesita ahora.
        url_recuperar=f"{PUBLIC_BASE_URL}/reset-password",
    )
    return await send_email(to, asunto, html, texto)


async def send_subscription_canceled_email(to: str, plan_nombre: str,
                                           plan_gratis: dict[str, Any] | None = None) -> bool:
    asunto, html, texto = plantillas.suscripcion_cancelada(
        plan_nombre=plan_nombre,
        limites_gratis=limites_de_plan(plan_gratis or {}),
        url_planes=f"{PUBLIC_BASE_URL}/planes",
    )
    return await send_email(to, asunto, html, texto)


async def send_payment_failed_email(to: str, plan_nombre: str, *,
                                    importe: str | None = None,
                                    reintento_iso: str | None = None,
                                    url_pago: str | None = None) -> bool:
    asunto, html, texto = plantillas.pago_fallido(
        plan_nombre=plan_nombre,
        importe=importe,
        reintento=fecha_larga(reintento_iso),
        # La factura de Stripe deja pagar y cambiar la tarjeta sin iniciar
        # sesión; la sección de facturación es el respaldo cuando no viene.
        url_pago=url_pago or f"{PUBLIC_BASE_URL}/account/facturacion",
    )
    return await send_email(to, asunto, html, texto)


def importe_de_factura(centavos: int | None, moneda: str | None) -> str | None:
    if not centavos:
        return None
    return f"${centavos / 100:.2f} {(moneda or 'usd').upper()}"
