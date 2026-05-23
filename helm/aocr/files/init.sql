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

ALTER TABLE images
    ADD COLUMN IF NOT EXISTS retention_mode VARCHAR(32);

ALTER TABLE images
    ADD COLUMN IF NOT EXISTS retention_value_seconds INTEGER;

ALTER TABLE images
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE images
    ADD COLUMN IF NOT EXISTS raw_retention_suffix VARCHAR(64);

ALTER TABLE images
    ADD COLUMN IF NOT EXISTS manifest_digest VARCHAR(255);

ALTER TABLE images
    ADD COLUMN IF NOT EXISTS last_pulled_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE images
    ADD COLUMN IF NOT EXISTS provenance VARCHAR(32);

ALTER TABLE images
    ADD COLUMN IF NOT EXISTS upstream_ref TEXT;

ALTER TABLE images
    ADD COLUMN IF NOT EXISTS cluster_id UUID;

ALTER TABLE images
    ADD COLUMN IF NOT EXISTS source_sandbox_id TEXT;

UPDATE images
SET last_pushed_at = COALESCE(last_pushed_at, created_at, CURRENT_TIMESTAMP)
WHERE last_pushed_at IS NULL;

UPDATE images
SET provenance = COALESCE(provenance, 'pushed')
WHERE provenance IS NULL;

UPDATE images
SET retention_mode = COALESCE(retention_mode, 'keep-latest')
WHERE retention_mode IS NULL;

ALTER TABLE images
    ALTER COLUMN last_pushed_at SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE images
    ALTER COLUMN last_pushed_at SET NOT NULL;

ALTER TABLE images
    ALTER COLUMN retention_mode SET DEFAULT 'keep-latest';

ALTER TABLE images
    ALTER COLUMN retention_mode SET NOT NULL;

ALTER TABLE images
    ALTER COLUMN provenance SET DEFAULT 'pushed';

ALTER TABLE images
    ALTER COLUMN provenance SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_images_repository_last_pushed_at
    ON images(repository_id, last_pushed_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_images_retention_expiry
    ON images(retention_mode, expires_at)
    WHERE retention_mode = 'ttl';

CREATE INDEX IF NOT EXISTS idx_images_idle_expiry
    ON images(retention_mode, last_pulled_at)
    WHERE retention_mode = 'idle';

-- Partial index for the mirror-idle reaper query in
-- hooks/src/util/imageRetention.ts (WHERE provenance = 'mirror' AND retention_mode <> 'ttl').
-- Existing installs whose old idx_images_provenance_idle was scoped to retention_mode = 'idle'
-- must run db/migrate-mirror-index.sql once — CREATE INDEX IF NOT EXISTS is a no-op when
-- the name already exists, so the predicate cannot be widened from init.sql alone.
CREATE INDEX IF NOT EXISTS idx_images_provenance_idle
    ON images(provenance, retention_mode, last_pulled_at, last_pushed_at)
    WHERE provenance = 'mirror' AND retention_mode <> 'ttl';

CREATE INDEX IF NOT EXISTS idx_images_provenance_cluster
    ON images(provenance, cluster_id)
    WHERE provenance = 'cluster-snapshot';
