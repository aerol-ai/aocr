CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE IF EXISTS users
    ADD COLUMN IF NOT EXISTS username VARCHAR(255);

ALTER TABLE IF EXISTS users
    ADD COLUMN IF NOT EXISTS email VARCHAR(255);

ALTER TABLE IF EXISTS users
    ADD COLUMN IF NOT EXISTS avatar_url TEXT;

ALTER TABLE IF EXISTS users
    ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(255);

ALTER TABLE IF EXISTS users
    ADD COLUMN IF NOT EXISTS profile JSONB DEFAULT '{}'::jsonb;

ALTER TABLE IF EXISTS images
    ADD COLUMN IF NOT EXISTS last_pushed_at TIMESTAMP WITH TIME ZONE;

UPDATE images
SET last_pushed_at = COALESCE(last_pushed_at, created_at, expires_at, CURRENT_TIMESTAMP)
WHERE last_pushed_at IS NULL;

ALTER TABLE IF EXISTS images
    ALTER COLUMN last_pushed_at SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE IF EXISTS images
    ALTER COLUMN last_pushed_at SET NOT NULL;

DROP INDEX IF EXISTS idx_images_expires_at;
ALTER TABLE IF EXISTS images DROP COLUMN IF EXISTS expires_at;

CREATE INDEX IF NOT EXISTS idx_images_repository_last_pushed_at
    ON images(repository_id, last_pushed_at DESC, created_at DESC);
