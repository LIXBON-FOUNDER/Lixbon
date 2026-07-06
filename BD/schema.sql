-- LIXBON — Esquema de referencia (generado desde core/persistence/models.py)
-- NO editar a mano: regenerar con `python BD/scripts/dump_schema.py`

CREATE TABLE app_versions (
	id SERIAL NOT NULL, 
	version TEXT NOT NULL, 
	channel TEXT NOT NULL, 
	release_date TEXT NOT NULL, 
	title TEXT NOT NULL, 
	changelog_json TEXT NOT NULL, 
	download_url TEXT NOT NULL, 
	checksum_sha256 TEXT, 
	created_at TEXT NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (version)
);

CREATE TABLE audit_events (
	id SERIAL NOT NULL, 
	event_type TEXT NOT NULL, 
	user_id INTEGER, 
	key_id INTEGER, 
	ip_address TEXT, 
	user_agent TEXT, 
	metadata_json TEXT, 
	created_at TEXT NOT NULL, 
	PRIMARY KEY (id)
);
CREATE INDEX idx_audit_user_type ON audit_events (user_id, event_type, created_at);

CREATE TABLE nodes (
	id TEXT NOT NULL, 
	name TEXT NOT NULL, 
	agent_url TEXT NOT NULL, 
	token TEXT NOT NULL, 
	enabled INTEGER NOT NULL, 
	created_at TEXT NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE users (
	id SERIAL NOT NULL, 
	username TEXT NOT NULL, 
	email TEXT, 
	first_name TEXT, 
	last_name TEXT, 
	role TEXT NOT NULL, 
	email_verified INTEGER NOT NULL, 
	password_hash TEXT NOT NULL, 
	created_at TEXT NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (username), 
	UNIQUE (email)
);

CREATE TABLE api_keys (
	id SERIAL NOT NULL, 
	user_id INTEGER NOT NULL, 
	name TEXT NOT NULL, 
	key_hash TEXT NOT NULL, 
	key_prefix TEXT, 
	raw_key TEXT, 
	is_active INTEGER NOT NULL, 
	status TEXT NOT NULL, 
	scopes TEXT NOT NULL, 
	model TEXT, 
	expires_at TEXT, 
	last_accessed TEXT, 
	last_used_ip TEXT, 
	deactivated_at TEXT, 
	created_at TEXT NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id), 
	UNIQUE (key_hash)
);
CREATE INDEX idx_api_keys_composite ON api_keys (user_id, is_active, created_at);
CREATE INDEX idx_api_keys_user_active ON api_keys (user_id, is_active);

CREATE TABLE conversations (
	id TEXT NOT NULL, 
	user_id INTEGER NOT NULL, 
	title TEXT, 
	client_id TEXT, 
	created_at TEXT NOT NULL, 
	updated_at TEXT NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id)
);
CREATE INDEX idx_conversations_user ON conversations (user_id, updated_at);

CREATE TABLE email_tokens (
	id SERIAL NOT NULL, 
	user_id INTEGER NOT NULL, 
	token_hash TEXT NOT NULL, 
	purpose TEXT NOT NULL, 
	expires_at TEXT NOT NULL, 
	used INTEGER NOT NULL, 
	created_at TEXT NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	UNIQUE (token_hash)
);
CREATE INDEX idx_email_tokens_user ON email_tokens (user_id, purpose);

CREATE TABLE sessions (
	id SERIAL NOT NULL, 
	user_id INTEGER NOT NULL, 
	token_hash TEXT NOT NULL, 
	expires_at TEXT NOT NULL, 
	ip_address TEXT, 
	user_agent TEXT, 
	created_at TEXT NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	UNIQUE (token_hash)
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

CREATE TABLE task_embeddings (
	id SERIAL NOT NULL, 
	user_id INTEGER NOT NULL, 
	user_input TEXT NOT NULL, 
	intent TEXT, 
	complexity FLOAT, 
	domain TEXT, 
	risk_level TEXT, 
	router_used TEXT, 
	model_called TEXT, 
	response_summary TEXT, 
	success INTEGER NOT NULL, 
	embedding_blob BYTEA, 
	created_at TEXT NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id)
);
CREATE INDEX idx_task_emb_user ON task_embeddings (user_id, created_at);

CREATE TABLE token_usage_daily (
	id SERIAL NOT NULL, 
	user_id INTEGER NOT NULL, 
	usage_date TEXT NOT NULL, 
	model TEXT NOT NULL, 
	prompt_tokens INTEGER NOT NULL, 
	completion_tokens INTEGER NOT NULL, 
	total_tokens INTEGER NOT NULL, 
	latency_sum_ms INTEGER NOT NULL, 
	request_count INTEGER NOT NULL, 
	created_at TEXT NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_token_usage_daily UNIQUE (user_id, usage_date, model), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX idx_token_usage_date ON token_usage_daily (usage_date);

CREATE TABLE messages (
	id SERIAL NOT NULL, 
	conversation_id TEXT NOT NULL, 
	role TEXT NOT NULL, 
	content TEXT NOT NULL, 
	model TEXT, 
	prompt_tokens INTEGER NOT NULL, 
	completion_tokens INTEGER NOT NULL, 
	total_tokens INTEGER NOT NULL, 
	latency_ms INTEGER NOT NULL, 
	created_at TEXT NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(conversation_id) REFERENCES conversations (id)
);
CREATE INDEX idx_messages_conv ON messages (conversation_id, created_at);
