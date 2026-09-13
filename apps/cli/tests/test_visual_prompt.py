from lixbon_cli.commands import visual_project_prompt


def test_react_con_api():
    p = visual_project_prompt("Nimbus", "nimbus", ["index.html", "contacto.html"], "react api")
    assert "nimbus-app/" in p
    assert "React 18 + Vite" in p and "Express" in p
    assert "server/" in p and "proxy de /api" in p
    assert "index.html, contacto.html" in p


def test_react_sin_api():
    p = visual_project_prompt("Nimbus", "nimbus", ["index.html"], "react")
    assert "Express" not in p.split("Reglas:")[1]


def test_stack_libre_se_pasa_tal_cual():
    p = visual_project_prompt("Nimbus", "nimbus", ["index.html"], "vue + fastapi")
    assert "con vue + fastapi." in p
