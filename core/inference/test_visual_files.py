import pytest
"""Archivos de un diseño de Visuals a partir de los mensajes (parser tolerante)."""
from core.inference.visual_files import extract_files, latest_version


def test_acepta_el_nombre_en_cualquier_sitio():
    assert [f["name"] for f in extract_files("```file:index.html\n<!doctype html>\n```")] == ["index.html"]
    assert extract_files("```html\nfile:menu.html\n<!DOCTYPE html>\n<p>b</p>\n```")[0] == {"name": "menu.html", "code": "<!DOCTYPE html>\n<p>b</p>"}
    assert extract_files("```html\n<!-- file: login.html -->\n<!doctype html>\n```")[0]["name"] == "login.html"
    assert extract_files("**file:registro.html**\n```html\n<!doctype html>\n```")[0]["name"] == "registro.html"


def test_sin_nombre_deduce_index_y_titulo():
    dos = extract_files("```html\n<!doctype html><title>Menú SABOR</title>\n```\n```html\n<!doctype html><title>Login</title>\n```")
    assert [f["name"] for f in dos] == ["index.html", "login.html"]
    assert extract_files("```js\nconsole.log(1)\n```") == []
    assert extract_files("```svg\n<svg viewBox='0 0 1 1'/>\n```")[0]["name"] == "logo.svg"


def test_la_ultima_version_hereda_las_paginas_no_reescritas():
    msgs = [
        {"role": "user", "content": "haz dos"},
        {"role": "assistant", "content": "```file:index.html\n<p>1</p>\n```\n```file:menu.html\n<p>m</p>\n```"},
        {"role": "user", "content": "cambia el menú"},
        {"role": "assistant", "content": "```file:menu.html\n<p>m2</p>\n```"},
    ]
    files, versiones = latest_version(msgs)
    assert versiones == 2
    assert [(f["name"], f["code"]) for f in files] == [("index.html", "<p>1</p>"), ("menu.html", "<p>m2</p>")]
    assert latest_version([{"role": "assistant", "content": "hola"}]) == ([], 0)


def test_edicion_search_replace_sobre_la_version_anterior():
    from core.inference.visual_files import apply_edits, extract_edits, latest_version

    html = '<!doctype html>\n<html><body>\n  <h1 class="a">Hola</h1>\n  <p>uno</p>\n</body></html>'
    msgs = [
        {"role": "assistant", "content": "Hecho.\n```file:index.html\n" + html + "\n```"},
        {"role": "assistant", "content": (
            "Cambio el título.\n```edit:index.html\n<<<<<<< SEARCH\n<h1 class=\"a\">Hola</h1>\n=======\n"
            "  <h1 class=\"b\">Adiós</h1>\n  <p>cero</p>\n>>>>>>> REPLACE\n"
            "<<<<<<< SEARCH\n  <p>uno</p>\n=======\n  <p>dos</p>\n>>>>>>> REPLACE\n```")},
        {"role": "assistant", "content": "Otra.\n```edit:index.html\n<<<<<<< SEARCH\n  <p>no existe</p>\n=======\n  <p>x</p>\n>>>>>>> REPLACE\n```"},
    ]
    assert len(extract_edits(msgs[1]["content"])[0]["pares"]) == 2
    files, n = latest_version(msgs[:2])
    assert n == 2
    assert files[0]["code"] == '<!doctype html>\n<html><body>\n  <h1 class="b">Adiós</h1>\n  <p>cero</p>\n  <p>dos</p>\n</body></html>'
    files3, n3 = latest_version(msgs)
    assert n3 == 2 and files3 == files
    with pytest.raises(ValueError):
        apply_edits("a\nb", [("zzz", "y")])


def test_sanear_html_arregla_apply_y_focus_visible():
    from core.inference.visual_files import sanear_html

    code = ('<script src="https://cdn.tailwindcss.com"></script>\n<style>\n  body { @apply bg-bg; }\n'
            '  .focus-visible { outline: 2px solid red; }\n</style>\n<a class="px-3 focus-visible">x</a>')
    out = sanear_html(code)
    assert '<style type="text/tailwindcss">' in out
    assert ":focus-visible { outline" in out and ".focus-visible {" not in out
    assert 'class="px-3 focus-visible"' in out
    assert sanear_html("<style>p{color:red}</style>") == "<style>p{color:red}</style>"
