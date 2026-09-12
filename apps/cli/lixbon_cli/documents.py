"""Lectura de archivos que no son texto plano: PDF y Word (texto extraído),
imágenes (van al modelo como adjunto de visión) y páginas web (html → texto)."""
import re
import subprocess
import sys
from pathlib import Path

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
PDF_EXTS = {".pdf"}
DOCX_EXTS = {".docx"}
MAX_PDF_PAGES = 200


def is_docx(path: Path) -> bool:
    return path.suffix.lower() in DOCX_EXTS


def is_binary(path: Path) -> bool:
    """Heurística de git: un NUL en los primeros 8 kB es binario."""
    try:
        with path.open("rb") as f:
            return b"\x00" in f.read(8192)
    except OSError:
        return False


def fmt_size(size: int) -> str:
    if size >= 1_000_000:
        return f"{size / 1_000_000:.1f} MB"
    if size >= 1000:
        return f"{size / 1000:.1f} kB"
    return f"{size} B"


def is_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_EXTS


def is_pdf(path: Path) -> bool:
    return path.suffix.lower() in PDF_EXTS


def _ensure(module: str, package: str):
    try:
        return __import__(module)
    except ImportError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", package])
        return __import__(module)


def pdf_text(path: Path) -> str:
    """Texto de un PDF, página a página con un separador para que el modelo
    pueda citar «página N». Un PDF escaneado (solo imágenes) devuelve vacío."""
    pypdf = _ensure("pypdf", "pypdf")
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


def docx_text(path: Path) -> str:
    """Párrafos y tablas de un .docx (python-docx se instala al primer uso)."""
    docx = _ensure("docx", "python-docx")
    doc = docx.Document(str(path))
    partes = [p.text for p in doc.paragraphs if p.text.strip()]
    for tabla in doc.tables:
        for fila in tabla.rows:
            celdas = [c.text.strip() for c in fila.cells if c.text.strip()]
            if celdas:
                partes.append(" | ".join(celdas))
    return "\n".join(partes) or "(el documento no tiene texto)"


_SCRIPT_RE = re.compile(r"<(script|style|noscript|svg)\b[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)
_BLOCK_RE = re.compile(r"</?(p|div|br|li|tr|h[1-6]|section|article|pre|blockquote)\b[^>]*>", re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]+>")


def html_to_text(html: str) -> str:
    import html as html_mod

    html = _SCRIPT_RE.sub(" ", html)
    html = _BLOCK_RE.sub("\n", html)
    text = html_mod.unescape(_TAG_RE.sub(" ", html))
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def describe_image(path: Path) -> str:
    kb = path.stat().st_size // 1024
    return (f"[imagen] {path.name} ({kb} kB): se te adjunta como imagen en el siguiente "
            "mensaje para que la veas directamente.")
