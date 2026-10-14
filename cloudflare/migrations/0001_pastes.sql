CREATE TABLE pastes (
    id TEXT PRIMARY KEY,
    lang TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
    burn INTEGER NOT NULL CHECK (burn IN (0, 1)),
    encrypted INTEGER NOT NULL CHECK (encrypted IN (0, 1))
);
CREATE INDEX pastes_expiry ON pastes(expires_at) WHERE expires_at > 0;
CREATE TABLE paste_chunks (
    paste_id TEXT NOT NULL REFERENCES pastes(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (paste_id, chunk_index)
);
