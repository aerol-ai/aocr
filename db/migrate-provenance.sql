CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE IF EXISTS images
    ADD COLUMN IF NOT EXISTS provenance VARCHAR(32);

ALTER TABLE IF EXISTS images
    ADD COLUMN IF NOT EXISTS upstream_ref TEXT;

ALTER TABLE IF EXISTS images
    ADD COLUMN IF NOT EXISTS cluster_id UUID;

ALTER TABLE IF EXISTS images
    ADD COLUMN IF NOT EXISTS source_sandbox_id TEXT;

UPDATE images
SET provenance = COALESCE(provenance, 'pushed')
WHERE provenance IS NULL;

ALTER TABLE IF EXISTS images
    ALTER COLUMN provenance SET DEFAULT 'pushed';

ALTER TABLE IF EXISTS images
    ALTER COLUMN provenance SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_images_provenance_idle
    ON images(provenance, retention_mode, last_pulled_at)
    WHERE provenance = 'mirror' AND retention_mode = 'idle';

CREATE INDEX IF NOT EXISTS idx_images_provenance_cluster
    ON images(provenance, cluster_id)
    WHERE provenance = 'cluster-snapshot';
