"""/api/skills/*: publicar versiones (admin), catálogo público, descarga verificable
y calificaciones. SQLite + TestClient."""
import base64
import hashlib
import io
import os
import pathlib
import shutil
import tempfile
import zipfile

_DB_DIR = pathlib.Path(tempfile.mkdtemp(prefix="lixbon_test_skills_"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_DB_DIR / 'skills.db').as_posix()}"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import update  # noqa: E402

from core.gateway import app as app_mod  # noqa: E402
from core.persistence import queries as q  # noqa: E402
from core.persistence.database import Base, get_engine, get_session  # noqa: E402
from core.persistence.models import Plan, User  # noqa: E402

SKILL_MD = """---
name: marketing-lxo
description: >-
  Crea campañas de Lixbon para redes. Publica las piezas en Visuals.
---

# Marketing
"""


def _t(text):
    return base64.b64encode(text.encode()).decode()


def _carpeta(skill_md=SKILL_MD, extra=None):
    files = [{"path": "marketing-lxo/SKILL.md", "base64": _t(skill_md)},
             {"path": "marketing-lxo/references/medios.md", "base64": _t("# Medios")},
             {"path": "marketing-lxo/evals/evals.json", "base64": _t("{}")}]
    return files + (extra or [])


def _registrar(c, correo, admin=False):
    r = c.post("/api/auth/register", json={
        "first_name": "Sk", "last_name": "Ill", "email": correo, "password": "contraseña-larga"})
    assert r.status_code in (200, 201), r.text
    if admin:
        with get_session() as s:
            s.execute(update(User).where(User.email == correo).values(role="admin"))


@pytest.fixture(scope="module")
def admin():
    Base.metadata.create_all(get_engine())
    with get_session() as s:
        for pid in ("free", "pro", "advance"):
            s.add(Plan(id=pid, name=pid, description="", price_monthly_cents=0, currency="USD",
                       messages_per_day=30, tokens_per_month=150000, max_api_keys=5, rate_limit_per_min=1000,
                       allowed_models=None, priority=0, sort_order=0, is_active=1,
                       created_at=q.now_iso(), updated_at=q.now_iso()))
    app_mod.init_db = lambda: None
    app_mod.versions.sync_versions_to_db = lambda: None
    app_mod.deps.orquestador.iniciar = lambda: None
    app_mod.deps.orquestador.detener = lambda: None
    with TestClient(app_mod.app) as c:
        _registrar(c, "skills-admin@lixbon.test", admin=True)
        yield c
    get_engine().dispose()
    shutil.rmtree(_DB_DIR, ignore_errors=True)


@pytest.fixture(scope="module")
def usuario(admin):
    with TestClient(app_mod.app) as c:
        _registrar(c, "skills-user@lixbon.test")
        yield c


@pytest.fixture(scope="module")
def anonimo(admin):
    with TestClient(app_mod.app) as c:
        yield c


def _publicar(c, version, files=None, changelog=""):
    return c.post("/api/admin/skills/versions",
                  json={"version": version, "changelog": changelog, "files": files or _carpeta()})


def test_solo_admin_publica(usuario, anonimo):
    assert _publicar(usuario, "1.0.0").status_code == 403
    assert _publicar(anonimo, "1.0.0").status_code == 401


def test_publicar_crea_oculta_y_despues_se_muestra(admin, anonimo):
    r = _publicar(admin, "1.0.0", changelog="Primera versión")
    assert r.status_code == 200, r.text
    sk = r.json()
    assert sk["slug"] == "marketing-lxo" and sk["published"] is False
    assert sk["summary"] == "Crea campañas de Lixbon para redes."
    assert [f["path"] for f in sk["files"]] == ["SKILL.md", "references/medios.md"]  # sin evals/
    assert anonimo.get("/api/skills").json()["skills"] == []
    assert anonimo.get("/api/skills/marketing-lxo").status_code == 404

    r = admin.patch("/api/admin/skills/marketing-lxo", json={
        "title": "Marketing de Lixbon", "description_md": "## Qué hace\nCampañas.", "category": "Marketing",
        "published": True})
    assert r.status_code == 200, r.text
    cards = anonimo.get("/api/skills").json()["skills"]
    assert [(c["slug"], c["command"], c["version"]) for c in cards] == [("marketing-lxo", "/marketing-lxo", "1.0.0")]
    det = anonimo.get("/api/skills/marketing-lxo").json()
    assert det["description_md"].startswith("## Qué hace") and det["versions"][0]["changelog"] == "Primera versión"
    assert det["rating_count"] == 0 and det["my_rating"] is None


def test_version_debe_crecer_y_ser_valida(admin):
    r = _publicar(admin, "1.0.0")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "version_not_newer"
    assert _publicar(admin, "0.9.0").status_code == 409
    assert _publicar(admin, "v2").json()["detail"]["code"] == "invalid_version"
    sin_skill = [{"path": "x/README.md", "base64": _t("hola")}]
    assert _publicar(admin, "2.0.0", files=sin_skill).json()["detail"]["code"] == "invalid_skill"
    malo = [{"path": "SKILL.md", "base64": _t("---\nname: a: b\n---\n")}]
    assert _publicar(admin, "2.0.0", files=malo).json()["detail"]["code"] == "invalid_skill"
    fuera = _carpeta(extra=[{"path": "marketing-lxo/../../etc/passwd", "base64": _t("x")}])
    assert _publicar(admin, "2.0.0", files=fuera).json()["detail"]["code"] == "invalid_path"
    r = _publicar(admin, "1.10.0", changelog="Revisión con visual_view")
    assert r.status_code == 200 and r.json()["version"] == "1.10.0"  # 1.10 > 1.9, no orden de texto


def test_descarga_con_sha_y_paquete_instalable(usuario, anonimo):
    assert anonimo.get("/api/skills/marketing-lxo/download").status_code == 401
    r = usuario.get("/api/skills/marketing-lxo/download", params={"client": "ide"})
    assert r.status_code == 200
    assert r.headers["x-skill-version"] == "1.10.0"
    assert hashlib.sha256(r.content).hexdigest() == r.headers["x-skill-sha256"]
    names = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
    assert names == ["marketing-lxo/SKILL.md", "marketing-lxo/references/medios.md"]
    old = usuario.get("/api/skills/marketing-lxo/download", params={"version": "1.0.0"})
    assert old.headers["x-skill-version"] == "1.0.0"
    assert anonimo.get("/api/skills").json()["skills"][0]["installs"] == 2


def test_paquete_determinista(admin):
    from core.persistence import skills as store
    files = [{"path": "SKILL.md", "data": SKILL_MD.encode()}, {"path": "a.md", "data": b"x"}]
    assert store.build_package(files)["sha256"] == store.build_package(list(reversed(files)))["sha256"]


def test_calificar(admin, usuario, anonimo):
    assert anonimo.put("/api/skills/marketing-lxo/rating", json={"stars": 5}).status_code == 401
    r = admin.put("/api/skills/marketing-lxo/rating", json={"stars": 5})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "rating_requires_install"
    assert usuario.put("/api/skills/marketing-lxo/rating", json={"stars": 6}).status_code == 422
    r = usuario.put("/api/skills/marketing-lxo/rating", json={"stars": 4})
    assert r.json() == {"rating_avg": 4.0, "rating_count": 1, "installs": 2, "my_rating": 4}
    r = usuario.put("/api/skills/marketing-lxo/rating", json={"stars": 2})
    assert r.json()["rating_count"] == 1 and r.json()["rating_avg"] == 2.0
    det = usuario.get("/api/skills/marketing-lxo").json()
    assert det["my_rating"] == 2 and det["installed_by_me"] is True
    assert anonimo.get("/api/skills/marketing-lxo").json()["my_rating"] is None
    assert usuario.delete("/api/skills/marketing-lxo/rating").json()["rating_count"] == 0


def test_ocultar_y_borrar(admin, usuario):
    admin.patch("/api/admin/skills/marketing-lxo", json={"published": False})
    assert usuario.get("/api/skills/marketing-lxo/download").status_code == 404
    assert len(admin.get("/api/admin/skills").json()["skills"]) == 1
    assert admin.delete("/api/admin/skills/marketing-lxo").status_code == 204
    assert admin.get("/api/admin/skills").json()["skills"] == []
