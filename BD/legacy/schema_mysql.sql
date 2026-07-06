-- lixbon DTC v2.0 MySQL Schema
-- Script para migrar la base de datos de SQLite a MySQL

CREATE DATABASE IF NOT EXISTS lixbon_dtc DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE lixbon_dtc;

-- Tabla de Usuarios
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    created_at VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla de API Keys
CREATE TABLE IF NOT EXISTS api_keys (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(255) NOT NULL,
    key_hash VARCHAR(255) NOT NULL UNIQUE,
    key_prefix VARCHAR(255) NULL,
    raw_key VARCHAR(255) NULL,
    is_active TINYINT NOT NULL DEFAULT 1,
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    scopes VARCHAR(255) NOT NULL DEFAULT 'read,write',
    model VARCHAR(255) NULL,
    expires_at VARCHAR(255) NULL,
    last_accessed VARCHAR(255) NULL,
    last_used_ip VARCHAR(100) NULL,
    deactivated_at VARCHAR(255) NULL,
    created_at VARCHAR(255) NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_api_keys_user_active ON api_keys(user_id, is_active);
CREATE INDEX idx_api_keys_composite ON api_keys(user_id, is_active, created_at);

-- Tabla de Conversaciones
CREATE TABLE IF NOT EXISTS conversations (
    id VARCHAR(255) PRIMARY KEY,
    user_id INT NOT NULL,
    title VARCHAR(255) NULL,
    client_id VARCHAR(255) NULL,
    created_at VARCHAR(255) NOT NULL,
    updated_at VARCHAR(255) NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_conversations_user ON conversations(user_id, updated_at);

-- Tabla de Mensajes
CREATE TABLE IF NOT EXISTS messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    conversation_id VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    model VARCHAR(255) NULL,
    prompt_tokens INT NOT NULL DEFAULT 0,
    completion_tokens INT NOT NULL DEFAULT 0,
    total_tokens INT NOT NULL DEFAULT 0,
    latency_ms INT NOT NULL DEFAULT 0,
    created_at VARCHAR(255) NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at);

-- Tabla de Eventos de Auditoría
CREATE TABLE IF NOT EXISTS audit_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    event_type VARCHAR(100) NOT NULL,
    user_id INT NULL,
    key_id INT NULL,
    ip_address VARCHAR(100) NULL,
    user_agent VARCHAR(255) NULL,
    metadata_json TEXT NULL,
    created_at VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_audit_user_type ON audit_events(user_id, event_type, created_at);

-- Tabla de Embeddings para Tareas (Vector Store)
CREATE TABLE IF NOT EXISTS task_embeddings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    user_input TEXT NOT NULL,
    intent VARCHAR(255) NULL,
    complexity DOUBLE NULL,
    domain VARCHAR(255) NULL,
    risk_level VARCHAR(50) NULL,
    router_used VARCHAR(255) NULL,
    model_called VARCHAR(255) NULL,
    response_summary TEXT NULL,
    success TINYINT NOT NULL DEFAULT 1,
    embedding_blob MEDIUMBLOB NULL,
    created_at VARCHAR(255) NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_task_emb_user ON task_embeddings(user_id, created_at DESC);

-- NUEVA: Tabla de Versiones (Stable y Beta)
CREATE TABLE IF NOT EXISTS app_versions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    version VARCHAR(50) NOT NULL UNIQUE,
    channel VARCHAR(50) NOT NULL DEFAULT 'stable', -- stable o beta
    release_date VARCHAR(100) NOT NULL,
    title VARCHAR(255) NOT NULL,
    changelog_json TEXT NOT NULL,
    download_url VARCHAR(512) NOT NULL,
    checksum_sha256 VARCHAR(255) NULL,
    created_at VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- NUEVA: Tabla de Uso de Tokens por Día/Usuario/Modelo (para gráficas eficientes)
CREATE TABLE IF NOT EXISTS token_usage_daily (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    usage_date DATE NOT NULL,
    model VARCHAR(255) NOT NULL,
    prompt_tokens INT NOT NULL DEFAULT 0,
    completion_tokens INT NOT NULL DEFAULT 0,
    total_tokens INT NOT NULL DEFAULT 0,
    latency_sum_ms INT NOT NULL DEFAULT 0,
    request_count INT NOT NULL DEFAULT 0,
    created_at VARCHAR(255) NOT NULL,
    UNIQUE KEY uq_user_date_model (user_id, usage_date, model),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_token_usage_date ON token_usage_daily(usage_date);
