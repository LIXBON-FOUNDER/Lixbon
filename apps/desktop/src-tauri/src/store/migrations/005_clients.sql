-- 005_clients: identidad de instalación y credenciales verificables (LXO-85).
-- Los tokens no se almacenan en claro; client_credentials conserva solo SHA-256.
-- Core/System es una identidad reservada en memoria y no puede registrarse aquí.

CREATE TABLE clients (
  client_id        TEXT PRIMARY KEY NOT NULL,
  surface          TEXT NOT NULL CHECK (surface IN ('desktop', 'cli', 'mobile', 'automation')),
  installation_id  TEXT NOT NULL CHECK (length(trim(installation_id)) BETWEEN 1 AND 200),
  device_id        TEXT CHECK (device_id IS NULL OR length(trim(device_id)) BETWEEN 1 AND 200),
  created_at       INTEGER NOT NULL,
  revoked_at       INTEGER,
  UNIQUE (surface, installation_id)
) STRICT;

CREATE TABLE client_credentials (
  credential_id  TEXT PRIMARY KEY NOT NULL,
  client_id      TEXT NOT NULL REFERENCES clients(client_id) ON DELETE RESTRICT,
  principal_kind TEXT NOT NULL CHECK (principal_kind IN ('person', 'agent')),
  principal_id   TEXT NOT NULL CHECK (length(trim(principal_id)) BETWEEN 1 AND 200),
  token_hash     TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at     INTEGER NOT NULL,
  revoked_at     INTEGER
) STRICT;

CREATE INDEX client_credentials_by_client
  ON client_credentials (client_id, revoked_at);
