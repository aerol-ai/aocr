# AOCR Ansible Deployment

This Ansible playbook automates the deployment and upgrading of the AOCR Helm chart to the Kubernetes cluster. It is designed to be fully idempotent, secure, and requires zero Python dependencies on the target VM.

## Features
- **Zero Remote Dependencies**: Uses native SSH commands to execute Helm, requiring no special Python libraries (like `kubernetes` or `PyYAML`) on the remote VM.
- **Dynamic Secret Generation**: Automatically generates highly secure Postgres passwords, Redis passwords, Hooks tokens, and Registry secrets if they are not provided.
- **Automated SSL/JWT Keys**: Automatically generates self-signed JWT certificates using OpenSSL if they do not exist locally, and securely syncs them to the VM before deployment.
- **S3 Credential Passthrough**: Injects your local AWS IAM credentials directly into the deployment without storing them in any local text files.
- **Strict Git Hygiene**: All generated secrets and optional `vars.yml` configurations are safely added to `.gitignore`.

## Prerequisites

1. **SSH Access**: You must have SSH access to the target VM (`ubuntu@34.230.16.251`). The playbook connects via your default SSH key configuration.
2. **AWS Credentials**: The AOCR registry requires standard AWS credentials for S3. You must have an AWS profile configured in your `~/.aws/credentials` file.
3. **Ansible & Helm**: Ansible must be installed on your local machine. Helm must be installed on the remote VM.

## Configuration

All configuration is safely isolated:

### 1. Environment Configuration (`vars.yml`)
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
- It auto-generates secure passwords for Postgres, Redis, Hooks, and the Registry if they are not provided, and saves them in plaintext inside the `secrets/` folder. This ensures the exact same passwords are automatically re-used on subsequent runs.

If you ever need to manually override these (e.g., specifying an AWS profile or hardcoding a Postgres password):
1. Copy the example file:
   `cp inventory/group_vars/all/secrets.yml.example inventory/group_vars/all/secrets.yml`
2. Define your explicit overrides (such as `aocr_aws_profile: "sandbox"`).

## Deployment Instructions

1. Ensure your `vars.yml` is configured.
2. Execute the playbook, passing the **exact chart version** you want to deploy as an extra parameter (`-e`):
   ```bash
   cd ansible
   ansible-playbook playbooks/deploy-aocr.yml -e "aocr_helm_chart_version=1.0.2-main.28"
   ```

*Note: Passing `-e "aocr_helm_chart_version=..."` at the command line will automatically override whatever version is written in your `vars.yml`. This is the best way to do routine upgrades!*

The playbook will handle namespace creation, idempotent certificate generation, file syncing, environment injection, and Helm upgrades automatically.
