"""
logging_setup.py — Logging estructurado (JSON) para el gateway.
En Railway los logs se leen mejor como JSON de una línea; en desarrollo
se puede desactivar con LOG_FORMAT=plain.
"""
from __future__ import annotations
import json
import logging
import os
import sys
import time


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        return json.dumps(entry, ensure_ascii=False)


def setup_logging() -> None:
    """Configura el root logger. JSON por defecto; LOG_FORMAT=plain para desarrollo."""
    handler = logging.StreamHandler(sys.stdout)
    if os.getenv("LOG_FORMAT", "json").lower() == "plain":
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    else:
        handler.setFormatter(JsonFormatter())

    root = logging.getLogger()
    root.setLevel(os.getenv("LOG_LEVEL", "INFO").upper())
    # Evitar handlers duplicados en reloads de uvicorn
    root.handlers = [handler]
