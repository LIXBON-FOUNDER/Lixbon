-- 003_projects: registro de proyectos del Core (slice D de la Fase 1).
--
-- UNA responsabilidad: separar la IDENTIDAD LÓGICA de un proyecto de su(s) RUTA(s)
-- en esta máquina. Nada más: ni eventos (E), ni clientes (F1), ni attention (G).
--
--   * projects          : identidad lógica (id UUID v7, nombre, huella, estado).
--   * project_locations : dónde está ese proyecto en una máquina (ruta normalizada).
--
-- Se aplica DESPUÉS de la valla (002) y solo con la instalación ya autoritativa: la
-- aplica `Store::migrate_authoritative`, que el arranque pide tras `decide_boot`.
--
-- Decisiones (docs/core/AUTORIDAD.md y LIXBON-modelo-runtime.md §6):
--   * Local por máquina y preparado para Team: `remote_project_id` / `team_project_id`
--     quedan VACÍOS hasta que exista Team (columnas NULL, sin lógica).
--   * `fingerprint` = {root_commits:[…], remotes:[…], default_branch}. Sirve para
--     RECONOCER un proyecto en otra ruta (y para pedir confirmación); nunca une en
--     silencio: un fork comparte commits raíz con su origen.
--   * `remotes` se guarda SIN credenciales (la normalización quita `usuario:token@`).
--   * `project_locations.project_id` es FK real. Los eventos (slice E) referenciarán
--     el proyecto con una referencia BLANDA: archivar o dejar de recordar un
--     proyecto no puede borrar ni bloquear su historia.
--   * `path` es la clave de búsqueda ya NORMALIZADA (en Windows sin distinguir
--     mayúsculas y con `/`); `display_path` es como la resolvió git, para mostrarla.
--   * Un proyecto tiene como mucho UNA ubicación principal por máquina.
--   * No se escribe nada dentro de ningún repositorio: el registro vive aquí.
--   * `Task.project_id` NO está en SQLite: las tareas siguen siendo el documento
--     `legacy_state`; el campo nuevo es `serde(default)` y el relleno pasa por `mutate`.

CREATE TABLE projects (
  id                TEXT    PRIMARY KEY,
  name              TEXT    NOT NULL CHECK (length(name) > 0),
  created_at        INTEGER NOT NULL,   -- ms epoch
  updated_at        INTEGER NOT NULL,   -- ms epoch
  remote_project_id TEXT,               -- reservado para Team
  team_project_id   TEXT,               -- reservado para Team
  fingerprint       TEXT    NOT NULL CHECK (json_valid(fingerprint)),
  settings          TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(settings)),
  state             TEXT    NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived'))
) STRICT;

CREATE TABLE project_locations (
  project_id   TEXT    NOT NULL REFERENCES projects (id),
  machine      TEXT    NOT NULL,
  path         TEXT    NOT NULL,        -- ruta normalizada (clave de búsqueda)
  display_path TEXT    NOT NULL,        -- ruta tal como la resolvió git
  last_seen    INTEGER NOT NULL,        -- ms epoch de la última comprobación
  is_primary   INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  state        TEXT    NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'missing')),
  PRIMARY KEY (machine, path)
) STRICT;

CREATE INDEX project_locations_by_project ON project_locations (project_id);

-- Como mucho una ubicación principal por proyecto y máquina.
CREATE UNIQUE INDEX project_locations_one_primary ON project_locations (project_id, machine) WHERE is_primary = 1;
