CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE IF EXISTS images
    ADD COLUMN IF NOT EXISTS retention_mode VARCHAR(32);

ALTER TABLE IF EXISTS images
    ADD COLUMN IF NOT EXISTS retention_value_seconds INTEGER;

ALTER TABLE IF EXISTS images
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE IF EXISTS images
    ADD COLUMN IF NOT EXISTS raw_retention_suffix VARCHAR(64);

ALTER TABLE IF EXISTS images
    ADD COLUMN IF NOT EXISTS manifest_digest VARCHAR(255);

UPDATE images
SET retention_mode = COALESCE(retention_mode, 'keep-latest')
WHERE retention_mode IS NULL;

ALTER TABLE IF EXISTS images
    ALTER COLUMN retention_mode SET DEFAULT 'keep-latest';

ALTER TABLE IF EXISTS images
    ALTER COLUMN retention_mode SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_images_retention_expiry
    ON images(retention_mode, expires_at)
    WHERE retention_mode = 'ttl';