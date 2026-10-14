-- Metadata shown in the admin paste list. Older pastes have no creator data.
ALTER TABLE pastes ADD COLUMN size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pastes ADD COLUMN creator_ip TEXT;
ALTER TABLE pastes ADD COLUMN country TEXT;
ALTER TABLE pastes ADD COLUMN client TEXT;
CREATE INDEX pastes_created ON pastes(created_at DESC);
CREATE INDEX pastes_creator_ip ON pastes(creator_ip) WHERE creator_ip IS NOT NULL;

-- Base64 chunks are 4/3 of the original size; padding makes this approximate.
UPDATE pastes SET size = (
    SELECT COALESCE(SUM(length(data)), 0) * 3 / 4 FROM paste_chunks WHERE paste_id = pastes.id
);

-- Admin-editable settings, stored as one JSON document per key.
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
);

-- Daily creation counters. They outlive pastes, which expire or burn.
CREATE TABLE paste_stats (
    day TEXT NOT NULL,
    lang TEXT NOT NULL,
    client TEXT NOT NULL,
    pastes INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    PRIMARY KEY (day, lang, client)
);

INSERT INTO paste_stats (day, lang, client, pastes, bytes)
SELECT date(created_at, 'unixepoch'), lang, 'unknown', COUNT(*), SUM(size)
FROM pastes GROUP BY 1, 2;
