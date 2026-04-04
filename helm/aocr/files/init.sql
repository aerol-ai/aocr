CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(255),
    email VARCHAR(255),
    display_name VARCHAR(255),
    avatar_url TEXT,
    auth_provider VARCHAR(255),
    profile JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile JSONB DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS repositories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    user_id UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(organization, name)
);

CREATE TABLE IF NOT EXISTS images (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id UUID REFERENCES repositories(id) ON DELETE CASCADE,
    tag VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_pushed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(repository_id, tag)
);

ALTER TABLE images
    ADD COLUMN IF NOT EXISTS last_pushed_at TIMESTAMP WITH TIME ZONE;

UPDATE images
SET last_pushed_at = COALESCE(last_pushed_at, created_at, CURRENT_TIMESTAMP)
WHERE last_pushed_at IS NULL;

ALTER TABLE images
    ALTER COLUMN last_pushed_at SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE images
    ALTER COLUMN last_pushed_at SET NOT NULL;

DROP INDEX IF EXISTS idx_images_expires_at;
ALTER TABLE images DROP COLUMN IF EXISTS expires_at;

CREATE INDEX IF NOT EXISTS idx_images_repository_last_pushed_at
    ON images(repository_id, last_pushed_at DESC, created_at DESC);
