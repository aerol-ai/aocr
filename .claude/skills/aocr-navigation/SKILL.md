---
name: aocr-navigation
description: 'Navigate the aocr repository. Use when you need to find where auth, hooks, reaper, mirror, web, registry, database, Helm, Ansible, CI, docs, or tests live, or when deciding which files own a behavior.'
---

# AOCR Navigation

## When To Use

- You need the first file to inspect for a change or bug.
- You need to know which service owns a behavior.
- You need to route mirror, `/v1/images`, or internal import/blob work.
- You want to avoid generated artifacts and open the real source files.

## Procedure

1. Read [the repo map](./references/repo-map.md).
2. Start at the owning entrypoint, not wrappers or generated output.
3. Prefer `auth/src/**`, `hooks/src/**`, `hooks/test/**`, `mirror/*.go`, `web/src/**`, `db/**`, and `helm/aocr/**`.
4. Use the root docs named in the repo map before inferring behavior from a plan file.

## Output Goal

Return a short routing answer that names:

- the owning service
- the first file to inspect
- one or two nearby follow-up files if the first file mostly wires behavior