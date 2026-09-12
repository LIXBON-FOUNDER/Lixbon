"""read_file y @adjuntos con PDF e imágenes: el PDF llega como texto por
páginas y la imagen viaja al modelo como adjunto de visión, no como bytes."""
import base64
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lixbon_cli import agent, commands, documents  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


def _pdf(path: Path, textos: list[str]) -> None:
    from pypdf import PdfWriter
    from pypdf.generic import DictionaryObject, NameObject, StreamObject

    w = PdfWriter()
    for texto in textos:
        page = w.add_blank_page(width=200, height=200)
        font = DictionaryObject({
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        })
        page[NameObject("/Resources")] = DictionaryObject({
            NameObject("/Font"): DictionaryObject({NameObject("/F1"): w._add_object(font)}),
        })
        stream = StreamObject()
        stream._data = f"BT /F1 12 Tf 10 100 Td ({texto}) Tj ET".encode()
        page[NameObject("/Contents")] = w._add_object(stream)
    with open(path, "wb") as f:
        w.write(f)


def test_read_file_de_pdf_devuelve_texto_por_paginas(tmp_path):
    _pdf(tmp_path / "informe.pdf", ["Hola portada", "Segunda pagina"])
    out = agent.tool_read_file(tmp_path, "informe.pdf")
    assert "── página 1 ──" in out and "Hola portada" in out
    assert "── página 2 ──" in out and "Segunda pagina" in out
    rango = agent.tool_read_file(tmp_path, "informe.pdf", 3, 4)
    assert "Segunda pagina" in rango and "Hola portada" not in rango


def test_pdf_escaneado_avisa_en_vez_de_devolver_vacio(tmp_path):
    from pypdf import PdfWriter

    w = PdfWriter()
    w.add_blank_page(width=100, height=100)
    with open(tmp_path / "scan.pdf", "wb") as f:
        w.write(f)
    assert "no tiene texto extraíble" in documents.pdf_text(tmp_path / "scan.pdf")


def test_read_file_de_imagen_la_apila_para_el_modelo(tmp_path):
    (tmp_path / "tier.png").write_bytes(PNG)
    session: dict = {}
    result, failed, _ = agent._execute(tmp_path, "read_file", {"path": "tier.png"})
    assert not failed and "[imagen] tier.png" in result
    agent._stash_image(session, tmp_path, "read_file", {"path": "tier.png"}, failed)
    imagenes = agent.pop_tool_images(session)
    assert imagenes == [base64.b64encode(PNG).decode("ascii")]
    assert agent.pop_tool_images(session) == []


def test_un_archivo_de_texto_no_apila_nada(tmp_path):
    (tmp_path / "a.txt").write_text("hola", encoding="utf-8")
    session: dict = {}
    agent._stash_image(session, tmp_path, "read_file", {"path": "a.txt"}, False)
    agent._stash_image(session, tmp_path, "read_file", {"path": "../fuera.png"}, False)
    assert agent.pop_tool_images(session) == []


def test_adjunto_pdf_con_arroba_llega_como_texto(tmp_path):
    _pdf(tmp_path / "doc.pdf", ["Contenido del pdf"])
    clean, images, files, errors = commands.parse_attachments("resume @doc.pdf", tmp_path)
    assert clean == "resume doc.pdf" and not images and not errors
    assert files[0][0] == "doc.pdf" and "Contenido del pdf" in files[0][1]
