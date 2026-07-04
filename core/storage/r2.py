"""
r2.py — Almacenamiento de releases en Cloudflare R2 (F6.5).

El disco de Railway es efímero: los instaladores subidos se perderían en cada
redeploy. R2 (S3-compatible, sin costo de egreso) es el almacén persistente.
El bucket es PRIVADO: el gateway sube los objetos y genera URLs prefirmadas de
corta duración al vuelo, así el binario nunca queda expuesto públicamente y la
credencial de R2 vive solo en el servidor.
"""
from __future__ import annotations

import logging
import threading
from typing import BinaryIO

from core.config import (
    R2_ACCESS_KEY_ID,
    R2_BUCKET,
    R2_PRESIGN_TTL_MIN,
    R2_SECRET_ACCESS_KEY,
    r2_configured,
    r2_endpoint,
)

logger = logging.getLogger("folax.r2")

_client = None
_lock = threading.Lock()


class R2NotConfigured(RuntimeError):
    """R2 no tiene credenciales/bucket configurados."""


def _get_client():
    """Cliente boto3 S3 apuntando a R2 (perezoso, thread-safe)."""
    global _client
    if _client is not None:
        return _client
    with _lock:
        if _client is not None:
            return _client
        if not r2_configured():
            raise R2NotConfigured(
                "Faltan R2_ACCOUNT_ID / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY"
            )
        import boto3
        from botocore.config import Config

        _client = boto3.client(
            "s3",
            endpoint_url=r2_endpoint(),
            aws_access_key_id=R2_ACCESS_KEY_ID,
            aws_secret_access_key=R2_SECRET_ACCESS_KEY,
            # R2 usa 'auto'; firma v4 obligatoria
            region_name="auto",
            config=Config(signature_version="s3v4"),
        )
        return _client


def upload_release(key: str, fileobj: BinaryIO, content_type: str | None = None) -> str:
    """Sube un objeto al bucket de releases y retorna su key. Lanza R2NotConfigured."""
    client = _get_client()
    extra = {"ContentType": content_type} if content_type else {}
    client.upload_fileobj(fileobj, R2_BUCKET, key, ExtraArgs=extra)
    logger.info(f"[r2] subido {key} a {R2_BUCKET}")
    return key


def presigned_get_url(key: str, ttl_min: int | None = None) -> str:
    """URL de descarga temporal (GET) para un objeto privado."""
    client = _get_client()
    expires = (ttl_min or R2_PRESIGN_TTL_MIN) * 60
    return client.generate_presigned_url(
        "get_object",
        Params={"Bucket": R2_BUCKET, "Key": key},
        ExpiresIn=expires,
    )


def object_exists(key: str) -> bool:
    client = _get_client()
    try:
        client.head_object(Bucket=R2_BUCKET, Key=key)
        return True
    except Exception:
        return False


def delete_object(key: str) -> None:
    client = _get_client()
    client.delete_object(Bucket=R2_BUCKET, Key=key)
