import type Database from 'better-sqlite3-multiple-ciphers';

const SCHEMA_VERSION = 8;

const SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  source TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity_id);
CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at);
`;

const SCHEMA_V2_SQL = `
CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  vector BLOB NOT NULL,
  text_content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY,
  from_entity TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_embeddings_entity ON embeddings(entity_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_observation ON embeddings(observation_id);
CREATE INDEX IF NOT EXISTS idx_relationships_from ON relationships(from_entity);
CREATE INDEX IF NOT EXISTS idx_relationships_to ON relationships(to_entity);
CREATE INDEX IF NOT EXISTS idx_relationships_type ON relationships(relation_type);
`;

const SCHEMA_V3_SQL = `
ALTER TABLE observations ADD COLUMN last_recalled_at TEXT;
ALTER TABLE observations ADD COLUMN recall_count INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_observations_recall_count ON observations(recall_count);
`;

const SCHEMA_V4_SQL = `
ALTER TABLE observations ADD COLUMN importance REAL DEFAULT 1.0;
`;

const SCHEMA_V5_SQL = `
ALTER TABLE observations ADD COLUMN kind TEXT;
CREATE INDEX IF NOT EXISTS idx_observations_kind ON observations(kind);
`;

const SCHEMA_V6_SQL = `
ALTER TABLE entities ADD COLUMN version_hash TEXT;
ALTER TABLE entities ADD COLUMN version_at TEXT;
`;

const SCHEMA_V7_SQL = `
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  redirect_uris TEXT NOT NULL,
  client_name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_auth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token TEXT PRIMARY KEY,
  token_type TEXT NOT NULL,
  client_id TEXT NOT NULL,
  linked_token TEXT,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires ON oauth_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_expires ON oauth_auth_codes(expires_at);
`;

// Personal Reflection stays in its own namespace and generation-specific
// tables; it is never represented as an entity/observation or included in the
// legacy global embeddings table.
const SCHEMA_V8_SQL = `
CREATE TABLE IF NOT EXISTS personal_reflection_generations (
  generation_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope = 'personal-reflection'),
  status TEXT NOT NULL CHECK (status IN ('inactive', 'active', 'retired')),
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_one_active_generation
  ON personal_reflection_generations(scope) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_one_inactive_generation
  ON personal_reflection_generations(scope) WHERE status = 'inactive';

CREATE TABLE IF NOT EXISTS personal_reflection_scope_state (
  scope TEXT PRIMARY KEY CHECK (scope = 'personal-reflection'),
  active_generation_id TEXT REFERENCES personal_reflection_generations(generation_id)
);

CREATE TABLE IF NOT EXISTS personal_reflection_records (
  scope TEXT NOT NULL CHECK (scope = 'personal-reflection'),
  generation_id TEXT NOT NULL REFERENCES personal_reflection_generations(generation_id) ON DELETE CASCADE,
  canonical_id TEXT NOT NULL,
  canonical_version INTEGER NOT NULL CHECK (canonical_version > 0),
  content TEXT NOT NULL,
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
  sensitivity TEXT NOT NULL DEFAULT 'private' CHECK (sensitivity = 'private'),
  PRIMARY KEY (scope, generation_id, canonical_id)
);
CREATE INDEX IF NOT EXISTS idx_pr_records_identity
  ON personal_reflection_records(scope, canonical_id);

CREATE TABLE IF NOT EXISTS personal_reflection_embeddings (
  scope TEXT NOT NULL CHECK (scope = 'personal-reflection'),
  generation_id TEXT NOT NULL,
  canonical_id TEXT NOT NULL,
  vector BLOB NOT NULL CHECK (length(vector) = 1536),
  PRIMARY KEY (scope, generation_id, canonical_id),
  FOREIGN KEY (scope, generation_id, canonical_id)
    REFERENCES personal_reflection_records(scope, generation_id, canonical_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS personal_reflection_operations (
  principal_id TEXT NOT NULL,
  operation_key TEXT NOT NULL CHECK (length(operation_key) = 64),
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  scope TEXT NOT NULL CHECK (scope = 'personal-reflection'),
  canonical_id TEXT NOT NULL,
  canonical_version INTEGER NOT NULL CHECK (canonical_version > 0),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
  generation_id TEXT,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (principal_id, operation_key)
);
`;

export function initializeSchema(db: Database.Database): void {
  db.exec(SCHEMA_V1_SQL);

  const versionRow = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
  const currentVersion = versionRow?.version ?? 0;

  if (currentVersion < 2) {
    db.exec(SCHEMA_V2_SQL);
  }

  if (currentVersion < 3) {
    // V3: access tracking columns on observations
    // ALTER TABLE ADD COLUMN is safe — no table rebuild, defaults apply to existing rows
    db.exec(SCHEMA_V3_SQL);
  }

  if (currentVersion < 4) {
    // V4: observation importance for manual boost in recall ranking
    // ALTER TABLE ADD COLUMN with DEFAULT is safe — existing rows get 1.0 (neutral)
    db.exec(SCHEMA_V4_SQL);
  }

  if (currentVersion < 5) {
    // V5: optional observation kind (fact, decision, question, preference, or custom)
    // ALTER TABLE ADD COLUMN is safe — existing rows get NULL (no kind)
    db.exec(SCHEMA_V5_SQL);
  }

  if (currentVersion < 6) {
    // V6: entity version hash for cross-platform staleness detection
    // ALTER TABLE ADD COLUMN is safe — existing rows get NULL (computed on next mutation)
    db.exec(SCHEMA_V6_SQL);
  }

  if (currentVersion < 7) {
    // V7: persist OAuth state (clients, auth codes, tokens) to survive container restarts
    db.exec(SCHEMA_V7_SQL);
  }

  if (currentVersion < 8) {
    // V8 is additive. Existing global tables and their indexes are untouched;
    // the new namespace remains empty until an authorized scoped upsert.
    db.exec(SCHEMA_V8_SQL);
  }

  if (!versionRow) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
  } else if (currentVersion < SCHEMA_VERSION) {
    db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
  }
}

export function getSchemaVersion(db: Database.Database): number {
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
  return row?.version ?? 0;
}
