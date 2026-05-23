---
name: aocr-retention
description: 'Trace aocr retention, tag policy, reaper, webhook, idle TTL, TTL suffixes, provenance, mirror cache, or cluster snapshot behavior. Use when debugging why an image was kept or deleted or when changing cleanup logic.'
---

# AOCR Retention

## When To Use

- A tag was deleted unexpectedly.
- A stale tag was not deleted.
- You are changing `--ttl-*`, `--idle-*`, provenance, or reaper behavior.
- You are debugging why a mirror pull or import did not show up in AOCR metadata.
- You need to trace how push and pull events update retention metadata.

## Procedure

1. Read [the retention path guide](./references/retention-paths.md).
2. Start with `hooks/src/util/tagRetention.ts` for parsing and classification.
3. Move to `hooks/src/controllers/HookAPI.ts` for metadata writes.
4. If the issue starts at the mirror or import boundary, inspect `mirror/proxy.go`, `hooks/src/controllers/ImportAPI.ts`, and `hooks/src/util/mountFromRepo.ts`.
5. Move to `hooks/src/util/imageRetention.ts` for stale selection and deletion.
6. Confirm the schema contract in `db/init.sql` and the user-facing contract in `RETENTION.md`.

## Output Goal

Explain:

- how the tag is classified
- which timestamp or retention field controls the decision
- which file owns the next change