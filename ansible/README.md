# AOCR Ansible Deployment

This Ansible playbook automates the deployment and upgrading of the AOCR Helm chart to the Kubernetes cluster. It is designed to be fully idempotent, secure, and requires zero Python dependencies on the target VM.

## Features
- **Zero Remote Dependencies**: Uses native SSH commands to execute Helm, requiring no special Python libraries (like `kubernetes` or `PyYAML`) on the remote VM.
- **Dynamic Secret Generation**: Automatically generates highly secure Postgres passwords, Redis passwords, Hooks tokens, and Registry secrets if they are not provided.
- **Automated SSL/JWT Keys**: Automatically generates self-signed JWT certificates using OpenSSL if they do not exist locally, and securely syncs them to the VM before deployment.
- **S3 Credential Passthrough**: Injects your local AWS IAM credentials directly into the deployment without storing them in any local text files.
- **Strict Git Hygiene**: All generated secrets and optional `vars.yml` configurations are safely added to `.gitignore`.

## Prerequisites

1. **SSH Access**: You must have SSH access to the target VM (`ubuntu@<your-vm-ip>`). The playbook connects via your default SSH key configuration.
2. **AWS Credentials**: The AOCR registry requires standard AWS credentials for S3. You must have an AWS profile configured in your `~/.aws/credentials` file.
3. **Ansible & Helm**: Ansible must be installed on your local machine. Helm must be installed on the remote VM.

## Configuration

All configuration is safely isolated:

### 1. Inventory Configuration (`hosts.yml`)
The target VM IP is private and ignored by git.
1. Copy the example file:
   `cp inventory/hosts.yml.example inventory/hosts.yml`
2. Open `hosts.yml` and replace `<your-vm-ip>` with your actual VM IP.

### 2. Environment Configuration (`vars.yml`)
Since infrastructure configuration (like domain routing and bucket names) is considered sensitive/private in this project, it is ignored by git. 

To set it up:
1. Copy the example file: 
   `cp inventory/group_vars/all/vars.yml.example inventory/group_vars/all/vars.yml`
2. Open `vars.yml` and fill in your actual values for:
   - `aocr_global_domain` (e.g., `aocr.aerol.ai`)
   - `aocr_registry_s3_bucket` (e.g., `aocr`)

### 2. Secrets Management (`secrets.yml` and `secrets/` folder)
This setup automatically handles password generation for you to prevent manual errors. 

When you run the playbook, it checks the ignored `secrets/` folder at the root of the project:
- If `jwt-private.pem` & `jwt-public.crt` don't exist, it auto-generates them.
- It auto-generates secure passwords for Postgres, Redis, Hooks, Auth PAT, and the Registry if they are not provided, and saves them in plaintext inside the `secrets/` folder. This ensures the exact same passwords are automatically re-used on subsequent runs.

If you ever need to manually override these (e.g., specifying an AWS profile or hardcoding a Postgres password):
1. Copy the example file:
   `cp inventory/group_vars/all/secrets.yml.example inventory/group_vars/all/secrets.yml`
2. Define your explicit overrides (such as `aocr_aws_profile: "sandbox"`).

## Deployment Instructions

1. Ensure your `vars.yml` is configured.
2. Execute the playbook, passing the **exact chart version** you want to deploy as an extra parameter (`-e`):
   ```bash
   cd ansible
   ansible-playbook playbooks/deploy-aocr.yml -e "aocr_helm_chart_version=1.1.1-main.44"
   ```

*Note: Passing `-e "aocr_helm_chart_version=..."` at the command line will automatically override whatever version is written in your `vars.yml`. This is the best way to do routine upgrades!*

The playbook will handle namespace creation, idempotent certificate generation, file syncing, environment injection, and Helm upgrades automatically.

## Authentication: API + Admin PAT

The registry supports two parallel authentication paths, and both are wired by this playbook:

| Path | When it fires | Driven by | Used by |
|------|---------------|-----------|---------|
| **API auth** | The presented password does **not** match any configured PAT | `aocr_auth_validationServiceUrl` in `vars.yml` → `auth.validationServiceUrl` in the chart | End users — your control plane (`app.aerol.ai/api/auth/info`) issues short-lived tokens after a normal login |
| **Static PAT** | The presented password matches a configured PAT (timing-safe compare) | `aocr_auth_pat_token` in `secrets.yml` → `auth.pat.token` in the chart | Admins / CI — the holder of the PAT logs in with `docker login` directly, bypassing the upstream API |

Order of evaluation in the auth service: **PAT first, API as fallback**. PAT matches skip the Postgres user sync and use a synthetic `static-pat` subject.

### Where the admin PAT lives

On the first run, the playbook auto-generates a 64-char PAT and saves it to `<repo-root>/secrets/auth_pat_token`. Subsequent runs reuse that file, so the value stays stable.

To look it up after deploy:
```bash
cat secrets/auth_pat_token
```

To override it explicitly, set `aocr_auth_pat_token` in `inventory/group_vars/all/secrets.yml`. Both single-token values and comma- or newline-separated multi-token lists are supported (the auth service splits on both), which is how you rotate or run multiple admin PATs side-by-side.

### Using the PAT with docker

```bash
docker login <your-domain> -u admin -p "$(cat secrets/auth_pat_token)"
docker push <your-domain>/org/repo:tag
```

The username field is ignored on the PAT path, so any non-empty string works. Treat the PAT like a root credential — anyone holding it gets full push/pull access.
