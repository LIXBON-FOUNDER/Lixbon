"""
email.py — Envío de emails transaccionales (verificación, reset de contraseña).
Proveedor: Resend (RESEND_API_KEY). Sin API key configurada, los links se
escriben en el log — modo desarrollo, el flujo completo sigue siendo probable.
"""
from __future__ import annotations

import logging
import os

import httpx

logger = logging.getLogger("folax.email")

RESEND_API_KEY = os.getenv("RESEND_API_KEY", "")
EMAIL_FROM = os.getenv("EMAIL_FROM", "FOLAX <no-reply@datacentgbx.online>")
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/")


async def send_email(to: str, subject: str, html: str) -> bool:
    """Envía un email. Retorna True si se envió (o se logueó en modo dev)."""
    if not RESEND_API_KEY:
        logger.warning(f"[email-dev] Para: {to} | Asunto: {subject}")
        logger.warning(f"[email-dev] Contenido: {html}")
        return True

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                "https://api.resend.com/emails",
                headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
                json={"from": EMAIL_FROM, "to": [to], "subject": subject, "html": html},
            )
            resp.raise_for_status()
        return True
    except Exception as exc:
        logger.error(f"No se pudo enviar email a {to}: {exc}")
        return False


def _layout(title: str, body: str, cta_text: str, cta_url: str) -> str:
    return f"""
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;
                background: #F6F7ED; border: 1px solid #171717; border-radius: 16px;">
      <h1 style="font-size: 22px; letter-spacing: 4px; color: #171717;">FOLAX</h1>
      <h2 style="color: #171717;">{title}</h2>
      <p style="color: #171717; line-height: 1.6;">{body}</p>
      <a href="{cta_url}" style="display: inline-block; background: #171717; color: #ffffff;
         padding: 12px 28px; border-radius: 999px; text-decoration: none; margin-top: 12px;">
        {cta_text}</a>
      <p style="color: #666; font-size: 12px; margin-top: 24px;">
        Si no solicitaste esto, ignora este correo.</p>
    </div>
    """


async def send_verification_email(to: str, token: str) -> bool:
    url = f"{PUBLIC_BASE_URL}/api/auth/verify-email?token={token}"
    return await send_email(
        to, "Verifica tu correo — FOLAX",
        _layout("Verifica tu correo", "Confirma tu dirección para completar tu registro en FOLAX.",
                "Verificar correo", url),
    )


async def send_password_reset_email(to: str, token: str) -> bool:
    url = f"{PUBLIC_BASE_URL}/reset-password?token={token}"
    return await send_email(
        to, "Restablece tu contraseña — FOLAX",
        _layout("Restablecer contraseña", "Recibimos una solicitud para cambiar tu contraseña. El enlace expira en 2 horas.",
                "Cambiar contraseña", url),
    )
