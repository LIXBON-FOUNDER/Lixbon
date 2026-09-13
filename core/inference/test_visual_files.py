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
