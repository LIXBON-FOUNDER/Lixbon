import json
import time
import shutil
from pathlib import Path
import secrets as _secrets
from fastapi import APIRouter, Query, HTTPException, UploadFile, File, Form, Header, Request
from fastapi.responses import HTMLResponse, JSONResponse
from app import db
from app.config import ADMIN_TOKEN, APP_VERSION
from app.security import cookie_auth_required

router = APIRouter()

# Cargar versiones iniciales desde versions.json y sincronizar con la base de datos
VERSIONS_JSON_PATH = Path(__file__).resolve().parent.parent / "versions.json"

def sync_versions_to_db():
    if VERSIONS_JSON_PATH.exists():
        try:
            with open(VERSIONS_JSON_PATH, "r", encoding="utf-8") as f:
                versions_data = json.load(f)
            for v in versions_data:
                db.add_app_version(
                    version=v["version"],
                    channel=v["channel"],
                    release_date=v["release_date"],
                    title=v["title"],
                    changelog=v["changelog"],
                    download_url=v["download_url"],
                    checksum=v.get("checksum_sha256")
                )
        except Exception as e:
            print(f"[versions] Error al sincronizar versiones: {e}")

# Sincronizar al importar el módulo - removido para llamarse en on_startup
# sync_versions_to_db()

@router.get("/api/versions")
async def get_versions():
    """Obtiene la lista de todas las versiones registradas."""
    return db.get_all_versions()

@router.get("/api/versions/current")
async def get_current_version():
    """Obtiene la versión actual instalada en el servidor."""
    return {"version": APP_VERSION}

@router.get("/api/updates/check")
async def check_update(v: str = Query(..., description="Versión instalada en el cliente")):
    """Compara la versión del cliente con la última versión disponible en el servidor."""
    latest_stable = db.get_latest_version(channel="stable")
    latest_beta = db.get_latest_version(channel="beta")
    
    # Determinar si el usuario está en canal beta
    is_beta_client = "beta" in v.lower() or "rc" in v.lower()
    latest_release = latest_beta if is_beta_client else latest_stable
    
    if not latest_release:
        return {"update_available": False, "latest_version": v}
        
    latest_v = latest_release["version"]
    
    # Comparación de versión simple (versión de texto simple)
    # En producción se recomienda packaging.version, pero aquí hacemos comparación básica
    update_available = (latest_v != v)
    
    return {
        "update_available": update_available,
        "current_version": v,
        "latest_version": latest_v,
        "channel": latest_release["channel"],
        "title": latest_release["title"],
        "release_date": latest_release["release_date"],
        "changelog": latest_release["changelog"],
        "download_url": latest_release["download_url"],
        "checksum_sha256": latest_release["checksum_sha256"]
    }

@router.get("/api/updates/manifest/{channel}")
async def get_tauri_manifest(channel: str, request: Request):
    """Devuelve el manifest en el formato estándar que espera el Tauri Auto-updater."""
    if channel not in ["stable", "beta"]:
        raise HTTPException(status_code=400, detail="Canal de actualización inválido")
        
    latest = db.get_latest_version(channel=channel)
    if not latest:
        raise HTTPException(status_code=404, detail="No se encontró versión para este canal")
        
    # El updater de Tauri 2 espera un JSON con este formato:
    # https://v2.tauri.app/reference/configuration/updater/#manifest-format
    # {
    #   "version": "2.5.0",
    #   "notes": "Changelog...",
    #   "pub_date": "2026-07-01T00:00:00Z",
    #   "platforms": {
    #     "windows-x86_64": { "url": "...", "signature": "..." }
    #   }
    # }
    notes = "\n".join([f"- {item}" for item in latest["changelog"]])
    
    # Construir la URL absoluta
    base_url = str(request.base_url).rstrip("/")
    download_url = latest["download_url"]
    if not download_url.startswith("http://") and not download_url.startswith("https://"):
        download_url = f"{base_url}{download_url}"
        
    return {
        "version": latest["version"],
        "notes": notes,
        "pub_date": latest["created_at"],
        "platforms": {
            # Se asume Windows por simplicidad, se puede extender para mac y linux
            "windows-x86_64": {
                "url": download_url,
                "signature": latest["checksum_sha256"] or ""
            }
        }
    }


def _require_admin_token(x_admin_token: str | None) -> None:
    """Valida el header X-Admin-Token contra ADMIN_TOKEN. Si no hay token configurado, el endpoint queda deshabilitado."""
    if not ADMIN_TOKEN:
        raise HTTPException(status_code=503, detail="Subida de versiones deshabilitada: ADMIN_TOKEN no configurado")
    if not x_admin_token or not _secrets.compare_digest(x_admin_token, ADMIN_TOKEN):
        raise HTTPException(status_code=401, detail="Token de administrador inválido")


@router.post("/api/versions/upload")
async def api_upload_version(
    version: str = Form(...),
    channel: str = Form(...),
    title: str = Form(...),
    changelog: str = Form(...),
    checksum_sha256: str = Form(None),
    file: UploadFile = File(...),
    x_admin_token: str | None = Header(default=None),
):
    """Sube un archivo de instalador de la app y registra la version en la base de datos. Solo admin."""
    _require_admin_token(x_admin_token)

    import re as _re
    if not _re.fullmatch(r"[A-Za-z0-9._-]+", version) or channel not in ("stable", "beta"):
        raise HTTPException(status_code=400, detail="Versión o canal inválidos")

    try:
        changelog_list = json.loads(changelog)
    except Exception:
        changelog_list = [changelog]

    # Guardar en app/static/releases/
    static_releases_dir = Path(__file__).resolve().parent.parent / "static" / "releases"
    static_releases_dir.mkdir(parents=True, exist_ok=True)
    
    filename = f"app-folax-{version}-{channel}{Path(file.filename).suffix}"
    file_path = static_releases_dir / filename
    
    with file_path.open("wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
        
    download_url = f"/static/releases/{filename}"
    
    # Agregar/actualizar en base de datos
    db.add_app_version(
        version=version,
        channel=channel,
        release_date=time.strftime("%Y-%m-%d"),
        title=title,
        changelog=changelog_list,
        download_url=download_url,
        checksum=checksum_sha256
    )
    
    return {
        "success": True, 
        "version": version, 
        "download_url": download_url
    }


@router.get("/releases-info", response_class=HTMLResponse)
async def releases_page():
    """Página pública de notas de versiones."""
    all_versions = db.get_all_versions()
    
    versions_html = ""
    for v in all_versions:
        badge_color = "#10b981" if v["channel"] == "stable" else "#f59e0b"
        changelog_list = "".join([f"<li>{item}</li>" for item in v["changelog"]])
        
        versions_html += f"""
        <div class="card">
            <div class="card-header">
                <h2>v{v["version"]} <span class="badge" style="background-color: {badge_color}">{v["channel"].upper()}</span></h2>
                <span class="date">{v["release_date"]}</span>
            </div>
            <h3>{v["title"]}</h3>
            <ul>
                {changelog_list}
            </ul>
            <div class="card-actions">
                <a href="{v["download_url"]}" class="btn">Descargar Instalador</a>
            </div>
        </div>
        """
        
    html_content = f"""
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Notas de Lanzamiento — FOLAX DTC</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono&display=swap" rel="stylesheet">
        <style>
            :root {{
                --bg-primary: #0a0a0a;
                --bg-secondary: #111111;
                --bg-surface: #1a1a1a;
                --accent: #7c3aed;
                --text-primary: #e5e5e5;
                --text-secondary: #888888;
                --border: #222222;
            }}
            body {{
                font-family: 'Inter', sans-serif;
                background-color: var(--bg-primary);
                color: var(--text-primary);
                margin: 0;
                padding: 40px 20px;
                display: flex;
                flex-direction: column;
                align-items: center;
            }}
            .container {{
                max-width: 800px;
                width: 100%;
            }}
            header {{
                text-align: center;
                margin-bottom: 50px;
            }}
            h1 {{
                font-size: 2.5rem;
                margin-bottom: 10px;
                font-weight: 700;
                background: linear-gradient(135deg, #7c3aed, #3b82f6);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
            }}
            header p {{
                color: var(--text-secondary);
                font-size: 1.1rem;
            }}
            .card {{
                background-color: var(--bg-secondary);
                border: 1px solid var(--border);
                border-radius: 12px;
                padding: 24px;
                margin-bottom: 30px;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
                transition: transform 0.2s, border-color 0.2s;
            }}
            .card:hover {{
                transform: translateY(-2px);
                border-color: var(--accent);
            }}
            .card-header {{
                display: flex;
                justify-content: space-between;
                align-items: center;
                border-bottom: 1px solid var(--border);
                padding-bottom: 12px;
                margin-bottom: 16px;
            }}
            .card-header h2 {{
                margin: 0;
                font-size: 1.5rem;
                display: flex;
                align-items: center;
                gap: 10px;
            }}
            .badge {{
                font-size: 0.75rem;
                padding: 4px 8px;
                border-radius: 6px;
                color: #ffffff;
                font-weight: 600;
            }}
            .date {{
                color: var(--text-secondary);
                font-family: 'JetBrains Mono', monospace;
                font-size: 0.9rem;
            }}
            h3 {{
                margin-top: 0;
                color: #ffffff;
                font-weight: 500;
            }}
            ul {{
                padding-left: 20px;
                margin-bottom: 24px;
            }}
            li {{
                margin-bottom: 8px;
                color: var(--text-primary);
                line-height: 1.6;
            }}
            .card-actions {{
                display: flex;
                justify-content: flex-end;
            }}
            .btn {{
                background-color: var(--accent);
                color: white;
                text-decoration: none;
                padding: 10px 20px;
                border-radius: 8px;
                font-weight: 500;
                font-size: 0.95rem;
                transition: opacity 0.2s;
            }}
            .btn:hover {{
                opacity: 0.9;
            }}
        </style>
    </head>
    <body>
        <div class="container">
            <header>
                <h1>Notas de Lanzamiento — FOLAX DTC</h1>
                <p>Historial de actualizaciones oficiales de la plataforma y App Folax</p>
            </header>
            
            {versions_html}
        </div>
    </body>
    </html>
    """
    return html_content
