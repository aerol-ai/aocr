-- Migration: widen idx_images_provenance_idle predicate to match the actual
-- mirror-idle reaper query in hooks/src/util/imageRetention.ts.
--
-- Old predicate (pre-fix):
--   WHERE provenance = 'mirror' AND retention_mode = 'idle'
--
-- New predicate:
--   WHERE provenance = 'mirror' AND retention_mode <> 'ttl'
--
-- The old predicate covered roughly zero rows in practice because mirror tags
-- default to retention_mode = 'keep-latest'. The reaper had to fall back to
-- another plan; this migration restores index coverage for the mirror cache.
--
-- This change cannot live in init.sql (which is "ensure this exists"-style):
-- CREATE INDEX IF NOT EXISTS is a no-op when the name already exists, so the
-- predicate of an existing partial index cannot be widened without an explicit
-- DROP. Hence this one-shot.
--
-- Safe to run multiple times: DROP INDEX IF EXISTS + CREATE INDEX IF NOT EXISTS.

DROP INDEX IF EXISTS idx_images_provenance_idle;

CREATE INDEX IF NOT EXISTS idx_images_provenance_idle
    ON images(provenance, retention_mode, last_pulled_at, last_pushed_at)
    WHERE provenance = 'mirror' AND retention_mode <> 'ttl';
