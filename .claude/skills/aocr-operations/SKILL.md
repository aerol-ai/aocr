---
name: aocr-operations
description: 'Navigate aocr deployment, Helm, Docker Compose, Ansible, registry config, observability, garbage collection, and CI publishing. Use when changing local stack wiring, Kubernetes manifests, self-hosting, metrics, or release packaging.'
---

# AOCR Operations

## When To Use

- You are changing deployment or runtime configuration.
- You need to know whether a change belongs in Compose, Helm, Ansible, or CI.
- You are tracing metrics, dashboards, or garbage collection wiring.

## Procedure

1. Read [the operations map](./references/operations-map.md).
2. Decide whether the change is local development, Kubernetes deployment, VM automation, registry runtime config, or CI publishing.
3. Start at the nearest configuration surface and only then inspect the runtime code.

## Output Goal

Return the owning deployment surface plus any mirrored files that must stay in sync.