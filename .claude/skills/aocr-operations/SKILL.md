---
name: aocr-operations
description: 'Navigate aocr deployment, Helm, Docker Compose, Ansible, mirror and registry config, schema sync, observability, garbage collection, and CI publishing. Use when changing local stack wiring, Kubernetes manifests, self-hosting, metrics, or release packaging.'
---

# AOCR Operations

## When To Use

- You are changing deployment or runtime configuration.
- You need to know whether a change belongs in Compose, Helm, Ansible, mirror or registry runtime config, or CI.
- You are tracing metrics, dashboards, mirror ingress, schema sync, or garbage collection wiring.

## Procedure

1. Read [the operations map](./references/operations-map.md).
2. Decide whether the change is local development, Kubernetes deployment, VM automation, mirror or registry runtime config, live schema sync, or CI publishing.
3. Start at the nearest configuration surface and only then inspect the runtime code.

## Output Goal

Return the owning deployment surface plus any mirrored files that must stay in sync.