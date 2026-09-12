"""Lectura de archivos que no son texto plano: PDF (texto extraído) e imágenes
(van al modelo como adjunto de visión, no como bytes)."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
PDF_EXTS = {".pdf"}
MAX_PDF_PAGES = 200


def is_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_EXTS


def is_pdf(path: Path) -> bool:
    return path.suffix.lower() in PDF_EXTS


def _ensure_pypdf():
    try:
        import pypdf
    except ImportError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "pypdf"])
        import pypdf
    return pypdf


def pdf_text(path: Path) -> str:
    """Texto de un PDF, página a página con un separador para que el modelo
    pueda citar «página N». Un PDF escaneado (solo imágenes) devuelve vacío."""
    pypdf = _ensure_pypdf()
    reader = pypdf.PdfReader(str(path))
    partes = []
    for i, page in enumerate(reader.pages[:MAX_PDF_PAGES], 1):
        try:
            texto = (page.extract_text() or "").strip()
        except Exception:
            texto = ""
        partes.append(f"── página {i} ──\n{texto}")
    if len(reader.pages) > MAX_PDF_PAGES:
        partes.append(f"…[{len(reader.pages) - MAX_PDF_PAGES} páginas más no extraídas]")
    if not any(p.split("\n", 1)[1].strip() for p in partes):
        return ("(el PDF no tiene texto extraíble: probablemente es un escaneo; "
                "conviértelo a imagen para que el modelo lo vea)")
    return "\n".join(partes)


def describe_image(path: Path) -> str:
    kb = path.stat().st_size // 1024
    return (f"[imagen] {path.name} ({kb} kB): se te adjunta como imagen en el siguiente "
            "mensaje para que la veas directamente.")
