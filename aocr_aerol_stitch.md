# AOCR ↔ AerolVM Stitch Guide

End-to-end guide for operating both an AOCR deployment and an AerolVM
cluster, with the cluster routing every public-registry pull through AOCR's
authenticated mirror — and optionally auto-importing each first pull into a
cluster-owned namespace so future failovers are decoupled from the original
upstream credential.

This doc is the single page that answers: "I have both repos. Where do I
start, what gets generated, and how do the two halves connect?" It
intentionally duplicates content from `MIRROR.md` and the `sandbox-library`
READMEs so you can read it standalone six months from now.

## Mental model

```
   ┌─────────────────────────┐                      ┌─────────────────────────┐
   │  AerolVM cluster        │                      │  AOCR                   │
   │  (sandbox-library)      │                      │  (aocr.sh)              │
   │                         │   1. wrapped cred    │                         │
   │  sandboxd in a sandbox  │ ────────────────────▶│  mirror vhost           │
   │  does:                  │   docker pull        │  mirror.<domain>        │
   │  docker pull            │                      │  • unwraps cred         │
   │  ghcr.io/private/foo    │                      │  • pulls from upstream  │
   │                         │                      │  • caches in S3         │
   │                         │   2. POST            │                         │
   │  on success, sandboxd:  │ ────────────────────▶│  hooks vhost            │
   │  POST /v1/internal/     │   Authorization:     │  aocr.<domain>          │
   │  imports                │   Bearer <internal   │  • re-mounts cached     │
   │                         │   _api_token>        │    bytes under          │
   │                         │                      │    cluster/<id>/        │
   │                         │                      │    _imported/...        │
   └─────────────────────────┘                      └─────────────────────────┘
```

Two flows, two AOCR vhosts, two secret types crossing the boundary:

| Flow | Vhost on AOCR | Cred sandboxd presents | What AOCR validates with |
|---|---|---|---|
| Cached pull (always) | `mirror.<domain>` | Wrapped upstream cred in Docker `identitytoken` | `UPSTREAM_AUTH_WRAP_KEYS` (must contain the matching key) |
| Auto-import (optional) | `aocr.<domain>` → `/v1/internal/imports` | `Authorization: Bearer <token>` | `INTERNAL_API_TOKEN` (timing-safe) |

Three secrets you need to keep straight:

1. **Upstream wrap key** — base64 32-byte AES-GCM key. Lives in
   `aocr.sh/secrets/upstream_wrap_key` **or** as an inline
   `aocr_auth_upstream_wrap_key:` override in
   `aocr.sh/ansible/inventory/group_vars/all/secrets.yml` (see
   [resolving secret values](#resolving-aocr-secret-values) below). Shared
   between AOCR (decrypts) and every AerolVM node (encrypts). Without it,
   private upstream pulls 401 at the mirror.
2. **Internal API token** — opaque 64-char bearer. Lives in
   `aocr.sh/secrets/internal_api_token` **or** inline as
   `aocr_internal_api_token:` in `secrets.yml`. Only used for auto-import.
   Without it, the mirror still caches bytes — you just don't get the
   cluster-namespace copy.
3. **Admin PAT** — opaque 64-char bearer. Lives in
   `aocr.sh/secrets/auth_pat_token` **or** inline as
   `aocr_auth_pat_token:` in `secrets.yml`. Used for `docker login` against
   AOCR directly + the `/v1/images` admin listing. Has no role in the
   sandboxd → AOCR pipeline; it's an operator credential.

### Resolving AOCR secret values

Every secret the deploy playbook handles can either be inline in
`secrets.yml` (explicit override) or in a generated file under `secrets/`
(the default first-run behavior). When the override is set, the file is
never written — so `cat secrets/<file>` errors. Use this helper to pull
whichever form is in play:

```bash
cd /path/to/aocr.sh

aocr_secret() {
  # $1 = var name (e.g. aocr_auth_upstream_wrap_key)
  # $2 = filename under secrets/ (e.g. upstream_wrap_key)
  local s="ansible/inventory/group_vars/all/secrets.yml" v
  v=$(awk -F'"' -v k="^$1:" '$0 ~ k {print $2; exit}' "$s" 2>/dev/null)
  if [ -n "$v" ]; then echo "$v"; else cat "secrets/$2"; fi
}

aocr_secret aocr_auth_upstream_wrap_key upstream_wrap_key
aocr_secret aocr_internal_api_token     internal_api_token
aocr_secret aocr_auth_pat_token         auth_pat_token
```

Every command in the rest of this doc that says `cat secrets/<name>` can
be swapped for `aocr_secret aocr_<var> <name>` if you've overridden in
`secrets.yml`.

> Naming gotcha. The sandbox-library calls the internal-API-token file
> `cluster-pat` (variable: `sandboxd_auto_import_cluster_pat_src`). That's
> historical naming — the content is AOCR's `internal_api_token`, not the
> UUID-keyed cluster PAT used by `auth/src/clusterPat.ts`. The latter is a
> different concept entirely (sandbox-side `docker pull` of *already
> imported* cluster images) and is not what's being configured by F21.

## Part 1 — Deploy AOCR

If AOCR is already running, skip to [Part 2](#part-2--stitch-an-aerolvm-cluster-to-aocr).

### 1.1 What you need

- A VM (or Kubernetes node) with Helm and kubectl reachable, plus SSH from
  your laptop. The provided playbook assumes Ubuntu on a single VM with
  `helm` already installed.
- An AWS account + S3 bucket for the registry's backing store, plus an
  IAM principal (typically a profile in `~/.aws/credentials`) the playbook
  can read keys from.
- A domain you control on Cloudflare (or another DNS provider) so the
  registry, mirror, and hooks vhosts can resolve.

### 1.2 Configure

```bash
cd aocr.sh/ansible

# Inventory: VM IP
cp inventory/hosts.yml.example inventory/hosts.yml
$EDITOR inventory/hosts.yml

# Variables: domain, S3 bucket, mirror toggle, etc.
cp inventory/group_vars/all/vars.yml.example inventory/group_vars/all/vars.yml
$EDITOR inventory/group_vars/all/vars.yml

# Secrets: optional explicit overrides (AWS profile, fixed PAT, etc.)
cp inventory/group_vars/all/secrets.yml.example inventory/group_vars/all/secrets.yml
```

Required keys in `vars.yml`:

```yaml
aocr_global_domain:        "aocr.aerol.ai"
aocr_registry_s3_region:   "us-east-1"
aocr_registry_s3_bucket:   "aocr-prod"

aocr_helm_chart_version:   "1.x.y-main.NN"   # pick a published version

# Pull-through mirror (Phase 3). Required for F17-F21.
aocr_mirror_enabled:       true
# aocr_mirror_host: "mirror.aocr.aerol.ai"   # default = "mirror." + aocr_global_domain
aocr_mirror_allow_list:    "0.0.0.0/0"       # tighten in production
```

Required DNS records on Cloudflare (or your provider), pointing at the VM:

- `aocr.aerol.ai`        — apex / push + auth + hooks ingress
- `mirror.aocr.aerol.ai` — cached-pull ingress
- `auth.aocr.aerol.ai`   — Docker token endpoint

Add the mirror record **before** flipping `aocr_mirror_enabled: true` —
ingress provisioning otherwise loops on cert issuance.

### 1.3 Deploy

```bash
cd aocr.sh/ansible
ansible-playbook playbooks/deploy-aocr.yml
```

On first run the playbook generates and pins every secret you'll ever need:

| File written to `aocr.sh/secrets/` | Used for |
|---|---|
| `postgres_password`     | Postgres TCP auth for app pods |
| `redis_password`        | Redis TCP auth |
| `hooks_token`           | Registry webhook → hooks API |
| `registry_secret`       | Distribution's `replregSecret` |
| `auth_pat_token`        | Admin PAT for `docker login` + `/v1/images` |
| `internal_api_token`    | **Internal API token — used by AerolVM auto-import.** |
| `upstream_wrap_key`     | **AES-GCM key — used by AerolVM wrap-creds.** |
| `mirror_writer_password`| Internal: mirror → registry write path |
| `jwt-private.pem`       | Docker token JWT signing |
| `jwt-public.crt`        | Docker token JWT verification |

Re-runs reuse the same values. **These secrets are real — treat the
`secrets/` directory like any other credential store.** It's `.gitignore`-d
by default.

The playbook also auto-applies `helm/aocr/files/init.sql` against the live
Postgres pod after every Helm upgrade — see
[`ansible/README.md` § Database Schema Upgrades](ansible/README.md#database-schema-upgrades).

### 1.4 Verify

```bash
# Helm install landed
ssh ubuntu@<vm-ip> kubectl get pods -n aocr

# Registry challenge (= up)
curl -i https://aocr.aerol.ai/v2/       # 401 with auth challenge

# Mirror challenge (= up)
curl -i https://mirror.aocr.aerol.ai/v2/   # 401 with auth challenge
curl -i https://mirror.aocr.aerol.ai/      # 404 page not found (expected)

# Admin PAT works
docker login aocr.aerol.ai -u admin -p "$(cat aocr.sh/secrets/auth_pat_token)"

# Image list endpoint
curl -sf -H "Authorization: Bearer $(cat aocr.sh/secrets/auth_pat_token)" \
  "https://aocr.aerol.ai/v1/images?limit=5" | jq .
```

Deep dives:

- Architecture: [`ARCH.md`](ARCH.md), [`aocr_architecture_blog.md`](aocr_architecture_blog.md)
- Operator setup detail: [`SELF_HOSTING.md`](SELF_HOSTING.md)
- Mirror semantics: [`MIRROR.md`](MIRROR.md)
- Retention model: [`RETENTION.md`](RETENTION.md)
- Observability: [`OBSERVABILITY.md`](OBSERVABILITY.md)
- Image-list API spec: [`README.md` § Images API](README.md#images-api)

## Part 2 — Stitch an AerolVM cluster to AOCR

Once AOCR is up, route an AerolVM cluster through it. There are two paths
on the cluster side; pick **one**:

| You bootstrap nodes with… | Use |
|---|---|
| Terraform                  | [Part 2A — Terraform](#part-2a--terraform) |
| Ansible only               | [Part 2B — Ansible](#part-2b--ansible) |
| Terraform + Ansible later  | Part 2A first; Part 2B's `configure-ops.yml` reads the same env file and overwrites cleanly. |

Both paths consume the same four values from the AOCR side plus one label
you pick yourself.

### Common: the five inputs

```bash
cd /path/to/aocr.sh

# 1. Mirror host  — "mirror." + aocr_global_domain
grep aocr_global_domain ansible/inventory/group_vars/all/vars.yml
# → mirror.aocr.aerol.ai

# 2. Upstream wrap key (base64 32 bytes) — required for private pulls
aocr_secret aocr_auth_upstream_wrap_key upstream_wrap_key
# (falls back to `cat secrets/upstream_wrap_key` when no inline override
#  is set in secrets.yml — see "Resolving AOCR secret values" above)

# 3. Internal API token — only needed for auto-import (F21)
aocr_secret aocr_internal_api_token internal_api_token

# 4. Hooks URL — same as aocr_global_domain
# → https://aocr.aerol.ai
```

And **5. Cluster ID** — a label *you* choose. AOCR has no pre-registered
list of clusters; this is just a per-cluster namespace prefix on the AOCR
side. Constraint: `^[A-Za-z0-9_-]{1,64}$`. Examples:
`prod-aerolvm-us-east-1`, `staging`, `dev-suman`. Pick once per cluster,
never change it (changing it later orphans previously-imported tags under
the old namespace — not destructive, just confusing).

### Part 2A — Terraform

Add the `aocr = { ... }` block to `sandbox-library/Terraform/terraform.tfvars`:

```hcl
aocr = {
  enabled             = true
  mirror_host         = "mirror.aocr.aerol.ai"
  upstream_wrap_key   = "<paste contents of aocr.sh/secrets/upstream_wrap_key>"

  # Auto-import (F21) — drop these four if you only want the cached mirror.
  auto_import_enabled = true
  hooks_url           = "https://aocr.aerol.ai"
  cluster_id          = "prod-aerolvm-us-east-1"   # pick once, never change
  cluster_pat         = "<paste contents of aocr.sh/secrets/internal_api_token>"
  # retention_suffix  = "--idle-90d"   # default; cluster-imported tags live 90 days idle
}
```

Apply:

```bash
cd sandbox-library/Terraform
terraform plan       # expect nodes to recycle; user_data changed
terraform apply
```

`nodes.tf` sets `user_data_replace_on_change = true`, so existing EC2
instances **are replaced**. Bootstrap on the new instances writes the two
secrets to `/etc/sandboxd/secrets/` (`0600`), appends `SB_MIRROR_*` /
`SB_AUTO_IMPORT_*` to `/etc/sandboxd/cluster.env`, and restarts sandboxd.

Reference: [`sandbox-library/Terraform/README.md` § Connect this cluster to AOCR](https://github.com/aerolai/sandbox-library/blob/main/Terraform/README.md#connect-this-cluster-to-aocr-mirror--auto-import).

### Part 2B — Ansible

Each of the two secrets supports **two delivery modes** — pick whichever
fits. They're equivalent on the wire; the choice is purely about how the
value reaches the play.

| Mode | Var | Best for |
|---|---|---|
| Inline value | `sandboxd_upstream_wrap_key_value` / `sandboxd_auto_import_cluster_pat_value` | Single operator on a laptop. Paste the string into a gitignored override file. Play uses `copy: content:` with `no_log: true`. |
| Control-node file path | `sandboxd_upstream_wrap_key_src` / `sandboxd_auto_import_cluster_pat_src` | Fleet ops where Vault/SOPS/Secrets Manager renders the file on disk. Play uses `copy: src:`. |

If both are set for the same secret, inline wins. Leaving both empty
disables the corresponding feature.

**Critical**: put your override values in a **gitignored** file. The
clean pattern is to split `inventory/group_vars/all.yml` into a directory
of files — `all/defaults.yml` (committed, ships everything OFF) plus
`all/local.yml` (gitignored, per-operator). Ansible loads every `*.yml` in
the directory **alphabetically, later files win**, so `defaults.yml` <
`local.yml` means `local.yml` overrides correctly. See
[`sandbox-library/Ansible/README.md` § Step 2](https://github.com/aerolai/sandbox-library/blob/main/Ansible/README.md#step-2--choose-how-to-hand-the-secrets-to-the-play).

#### Option A — Inline values (recommended for laptop)

No control-node staging needed. Put this in `inventory/group_vars/all/local.yml`:

```yaml
sandboxd_mirror_host:                    "mirror.aocr.aerol.ai"
sandboxd_upstream_wrap_key_value:        "<base64 wrap key — Resolving AOCR secret values above>"

sandboxd_auto_import_enabled:            true
sandboxd_auto_import_hooks_url:          "https://aocr.aerol.ai"
sandboxd_auto_import_cluster_id:         "prod-aerolvm-us-east-1"
sandboxd_auto_import_cluster_pat_value:  "<internal API token>"
```

#### Option B — Control-node files (fleet / Vault)

Stage:

```bash
mkdir -p ~/aerol-secrets && chmod 0700 ~/aerol-secrets
cp /path/to/aocr.sh/secrets/upstream_wrap_key  ~/aerol-secrets/upstream_wrap_key
cp /path/to/aocr.sh/secrets/internal_api_token ~/aerol-secrets/cluster_pat
chmod 0600 ~/aerol-secrets/*
```

Then in `inventory/group_vars/all/local.yml`:

```yaml
sandboxd_mirror_host:                    "mirror.aocr.aerol.ai"
sandboxd_upstream_wrap_key_src:          "/home/you/aerol-secrets/upstream_wrap_key"

sandboxd_auto_import_enabled:            true
sandboxd_auto_import_hooks_url:          "https://aocr.aerol.ai"
sandboxd_auto_import_cluster_id:         "prod-aerolvm-us-east-1"
sandboxd_auto_import_cluster_pat_src:    "/home/you/aerol-secrets/cluster_pat"
```

#### Apply

```bash
cd sandbox-library/Ansible
ansible-playbook playbooks/configure-ops.yml
```

Reference: [`sandbox-library/Ansible/README.md` § Connect this cluster to AOCR](https://github.com/aerolai/sandbox-library/blob/main/Ansible/README.md#connect-this-cluster-to-aocr-mirror--auto-import)
and [`sandbox-library/AUTHENTICATED_MIRROR.md`](https://github.com/aerolai/sandbox-library/blob/main/AUTHENTICATED_MIRROR.md)
for the per-env-var contract.

### Common: verification

On any AerolVM node:

```bash
sudo grep -E '^SB_(MIRROR|AUTO_IMPORT)_' /etc/sandboxd/cluster.env
sudo ls -l /etc/sandboxd/secrets/        # both files 0600 root:root
systemctl is-active sandboxd
```

Trigger a private pull through a sandbox, then on AOCR:

```bash
TOKEN=$(cat aocr.sh/secrets/auth_pat_token)

# Mirror cache populated?
curl -sf -H "Authorization: Bearer $TOKEN" \
  "https://aocr.aerol.ai/v1/images?limit=20" | jq -r '.images[].repository' | sort -u

# Auto-import landed under your cluster namespace?
curl -sf -H "Authorization: Bearer $TOKEN" \
  "https://aocr.aerol.ai/v1/images?limit=200" | jq -r '.images[].repository' \
  | grep "cluster/prod-aerolvm-us-east-1/_imported/"
```

## Operating both halves

### Rotating secrets

| Secret | Where it lives | Who consumes it | How to rotate |
|---|---|---|---|
| Upstream wrap key | `aocr.sh/secrets/upstream_wrap_key` | AOCR mirror unwraps; AerolVM nodes wrap | Add new key alongside old in AOCR's `UPSTREAM_AUTH_WRAP_KEYS` (comma-sep), redeploy AOCR, then push new key to every AerolVM node (Terraform: edit `aocr.upstream_wrap_key` + `apply`; Ansible: edit `sandboxd_upstream_wrap_key_value` OR overwrite the file at `_src`, then `configure-ops.yml`). After every node rotates, drop the old key from AOCR. |
| Internal API token | `aocr.sh/secrets/internal_api_token` | AOCR hooks validates; AerolVM nodes present | Rotate AOCR's `aocr_internal_api_token` in `secrets.yml` + redeploy. Push new value to every AerolVM node (Terraform: `aocr.cluster_pat`; Ansible: edit `sandboxd_auto_import_cluster_pat_value` OR overwrite the file at `_src`). Queued imports under the old token fail and retry under the new one. |
| Admin PAT | `aocr.sh/secrets/auth_pat_token` | Only operators (no node-side use) | Set `aocr_auth_pat_token` in `secrets.yml` (comma-sep list supports overlap), redeploy. Old PAT keeps working until you remove it. |

### Adding a second AerolVM cluster

Same AOCR, second cluster:

1. Stand up the new cluster with sandbox-library, exactly as the first.
2. Reuse the same `upstream_wrap_key` and `internal_api_token` from AOCR
   (they are shared across all clusters that point at this AOCR).
3. Pick a **different** `cluster_id` (e.g. `prod-aerolvm-us-west-2`). The
   namespace separation on the AOCR side comes from this label.
4. Apply on the new cluster only. The first cluster is untouched.

Both clusters' imported tags coexist under `cluster/<id>/_imported/...` on
the same AOCR.

### Tearing down a cluster

Terraform `destroy` recycles EC2 and removes the local config. **It does
not touch AOCR.** The imported tags under `cluster/<id>/_imported/...` keep
accumulating storage until either:

- the reaper evicts them (default `--idle-90d` suffix → 90 days untouched), or
- an operator deletes the prefix via `DELETE /v2/<repo>/manifests/<digest>`
  using the admin PAT, or
- the S3 lifecycle policy on the registry bucket fires (if configured).

If you destroy a cluster and don't plan to bring it back, the cleanest
path is to wait for idle eviction (cheap, automatic). If you need
immediate cleanup, delete the prefix manually before tearing down.

### Disabling the stitch without uninstalling AOCR

- **Terraform.** Set `aocr.enabled = false` (or drop the block) and
  `apply`. Nodes recycle; sandboxd boots with no `SB_MIRROR_*` /
  `SB_AUTO_IMPORT_*` env and pulls go direct to upstream again.
- **Ansible.** Set `sandboxd_mirror_host: ""` (and
  `sandboxd_auto_import_enabled: false`), then rerun `configure-ops.yml`.
  Same effect, no node recycle.

AOCR continues running with whatever images it cached, accessible via
admin PAT login.

## Troubleshooting

| Symptom | Likely cause | Where to look |
|---|---|---|
| All pulls work but mirror cache stays empty | `SB_MIRROR_HOST` empty, or the upstream isn't in `SB_MIRROR_UPSTREAMS` | sandboxd logs: `mirror not configured` |
| Private upstream pulls 401 at the mirror | Wrap key missing on cluster, or doesn't match an active key in AOCR's `UPSTREAM_AUTH_WRAP_KEYS` | sandboxd startup warning; AOCR mirror logs unwrap failure |
| `auto-import reconcile sweep failed` repeating | `auto_import_pending` rows piling up. Check `SB_AUTO_IMPORT_HOOKS_URL` reachability and that the cluster PAT matches AOCR's `INTERNAL_API_TOKEN` | sandboxd logs; AOCR hooks logs on `/v1/internal/imports` |
| AOCR `/v1/images` returns `{"error":"db_error"}` | Postgres missing a column added in a later `init.sql` — schema drift | Run `cd aocr.sh/ansible && ansible-playbook playbooks/apply-db-schema.yml`; see [`ansible/README.md` § Database Schema Upgrades](ansible/README.md#database-schema-upgrades) |
| `terraform plan` rejects with "hooks_url, cluster_id, cluster_pat are all required" | `auto_import_enabled = true` without all three | Fill in the three required fields, or set `auto_import_enabled = false` |
| Imported tags never appear under `cluster/<id>/_imported/...` | Check per-image reconciler outcome | `journalctl -u sandboxd | grep auto_import` on a node; AOCR hooks logs |
| Mirror returns 404 on `/` | Expected — Distribution exposes `/v2/`, `/v2`, `/metrics`, `/healthz` only | [`MIRROR.md` § Verify the mirror is up](MIRROR.md#verify-the-mirror-is-up) |

## Reference map

When you forget where something lives:

| You want to… | Read |
|---|---|
| Deploy / upgrade AOCR | `aocr.sh/ansible/README.md`, `SELF_HOSTING.md` |
| Understand the mirror's threat model | `MIRROR.md`, `sandbox-library/AUTHENTICATED_MIRROR.md` |
| Tune retention windows | `RETENTION.md` |
| Stitch a fresh AerolVM cluster to AOCR | This doc, then `sandbox-library/setup/aocr/README.md` |
| Set up dashboards / alerts | `OBSERVABILITY.md`, `deploy/grafana/` |
| Apply a missed schema change | `aocr.sh/ansible/README.md` § Database Schema Upgrades |
| Walk the auth code paths | `auth/src/server.ts`, `auth/src/clusterPat.ts` |
| Walk the import code paths | `hooks/src/controllers/ImportAPI.ts`, `hooks/src/controllers/HookAPI.ts` |
| List images via the API | `aocr.sh/README.md` § Images API |

## TL;DR

1. Deploy AOCR once with `aocr.sh/ansible/playbooks/deploy-aocr.yml`.
   Three vhosts come up (`aocr.<domain>`, `mirror.<domain>`,
   `auth.<domain>`); secrets land in `aocr.sh/secrets/`.
2. Per AerolVM cluster: copy `upstream_wrap_key` + `internal_api_token`
   from `aocr.sh/secrets/`, pick a `cluster_id` label, plug into either
   `terraform.tfvars` (Terraform path) or `inventory/group_vars/all.yml` +
   two control-node files (Ansible path), apply.
3. Verify: env on a node, then `curl /v1/images` on AOCR.
4. Rotate by editing the source on AOCR + re-applying on the cluster.
   Adding a second cluster is the same recipe with a different
   `cluster_id`.
