# `terraform/local-config` — environment files as managed resources

Renders the environment and config files ShipShape reads, using
`hashicorp/local`. No cloud account, no credentials, no network beyond the
provider download. This is the config referenced by requirements 8.1, 8.4, 8.7
and 8.8 in `docs/audit/lane-8-annotated-plan.md`.

## What it manages

| Resource | Renders | Mode |
|---|---|---|
| `local_sensitive_file.api_env` | `api/.env.local` | `0600` |
| `local_file.web_env` | `web/.env.local` | `0644` |
| `local_file.app_config` | `app.config.json` | `0644` |
| `local_file.deploy_manifest` | `deploy-manifest.json` | `0644` |
| `random_password.session_secret` | (state only, feeds `api_env`) | — |

## Run it

```bash
cd terraform/local-config
terraform init      # offline after the first provider download
terraform plan      # 5 to add, 0 to change, 0 to destroy on a clean checkout
terraform apply
```

Output lands in `generated/` by default, which is `.gitignore`d. That default
exists so a plain `apply` cannot overwrite a developer's working
`api/.env.local`. To render into the repo instead:

```bash
terraform apply \
  -var 'output_dir=../..' \
  -var "git_sha=$(git rev-parse HEAD)" \
  -var 'database_url=postgresql://localhost/ship_local'
```

## Drift detection

```bash
terraform apply -auto-approve
terraform plan                    # No changes.
echo '{"tampered":true}' > generated/app.config.json
terraform plan                    # detects it
terraform plan -refresh-only      # attributes it to an out-of-band change
terraform apply -auto-approve     # restores the declared content
```

Captured end to end in `docs/audit/lane-8-drift-detection.md`, including the two
cases where the provider does **not** detect drift.

## Rolling it back

Nothing outside this directory is touched while `output_dir` is left at its
default.

```bash
terraform destroy          # removes the generated files
rm -rf .terraform generated terraform.tfstate*
```

If you rendered into the repo with `-var 'output_dir=../..'`, `terraform
destroy` deletes `api/.env.local` and `web/.env.local` — recreate them with
`pnpm dev`, which writes `api/.env.local` itself when it is missing.

## Things that will bite you

- **`sensitive` controls display, not storage.** `database_url`,
  `session_secret` and the generated password are redacted from plan output and
  from `terraform output`, and are written to `terraform.tfstate` in plaintext.
  The root and `terraform/` ignore files cover `*.tfstate*` and `tfplan` at any
  depth. Do not commit a saved plan.
- **Regenerating `session_secret` logs everyone out.** It is keyed on
  `environment`; changing that value rotates it. For anything real, pass
  `-var session_secret=...` from a secrets manager so the value outlives this
  state file.
- **The provider does not detect a permissions change.** `chmod 0666` on a
  rendered file reports `No changes`, and `apply` will not repair the mode. For
  a `0600` env file that is a real gap — see the drift write-up.
- **Provider versions are exact pins**, not ranges. Change them deliberately and
  commit the regenerated `.terraform.lock.hcl` in the same commit.
