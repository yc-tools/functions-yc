# @yc-tools/functions-yc

Deploy a folder of TypeScript handler functions to **Yandex Cloud Functions** behind an **API Gateway**, using an embedded Terraform project. Each handler file becomes one cloud function; routes are derived from file paths.

## Requirements

- Node.js >= 20
- `terraform` available on `PATH`
- Yandex Cloud Object Storage static access keys (for artifact upload and, optionally, Terraform S3 state)

## Install

```bash
npm install -g @yc-tools/functions-yc
# or run ad hoc
npx @yc-tools/functions-yc --help
```

## Commands

### `functions-yc build`

Scans the handlers directory, bundles each handler with esbuild (Node 20 target, CJS, minified), writes zip artifacts and `functions.manifest.json` to the output directory.

| Option | Description | Default |
|---|---|---|
| `-p, --project <path>` | Project root | `.` |
| `-o, --output <path>` | Output directory | `.fyc-out` |
| `--handlers-dir <dir>` | Handlers directory, relative to project | `handlers` |
| `--app-name <name>` | Application name | project directory name |
| `--external <pkg>` | Mark package external and copy it from `node_modules` into the zip (repeatable) | — |
| `--memory <mb>` | Function memory in MB (positive integer) | `256` |
| `--timeout <s>` | Function timeout in seconds (positive integer) | `30` |
| `-v, --verbose` | Verbose output | — |

### `functions-yc deploy`

Builds, ensures the deploy bucket exists, uploads artifacts and the manifest to Object Storage, then runs `terraform apply` for the whole stack. Prints the API Gateway URL on success.

Accepts all `build` options plus:

| Option | Description |
|---|---|
| `--cloud-id <id>` / `--folder-id <id>` | Yandex Cloud IDs |
| `--iam-token <token>` | Yandex Cloud IAM token |
| `--access-key <key>` / `--secret-key <key>` | Object Storage static keys (required) |
| `--bucket <name>` | Deploy bucket name (otherwise read from Terraform outputs, created on first deploy) |
| `--state-bucket <name>` / `--state-key <key>` | Terraform S3 backend state bucket/key (omit both for local state) |
| `--nodejs-version <ver>` | `nodejs18` / `nodejs20` / `nodejs22` (default `nodejs18`) |
| `--domain <name>` | Custom domain name |
| `--dns-zone-id <id>` | Existing DNS zone ID |
| `--certificate-id <id>` | Existing TLS certificate ID |
| `--create-dns-zone` | Create a new DNS zone for the domain |
| `--zone <zone>` / `--region <region>` | Availability zone / region |
| `--env <env>` | Environment name (default `production`) |
| `--tf-var <key=value>` | Extra Terraform variable (repeatable) |
| `--auto-approve` | Run `terraform apply` with `-auto-approve` (otherwise Terraform prompts interactively) |

Option precedence: **CLI flag → `FYC_*` environment variable → config file**.

The keys `app_name`, `env`, `nodejs_version`, `cloud_id`, `folder_id` are managed by the CLI and cannot be set via `--tf-var` — use the dedicated options instead.

The app name (after sanitizing to lowercase letters, digits and hyphens) must match `^[a-z0-9][a-z0-9-]{1,29}[a-z0-9]$`.

## Handler conventions

Every `.ts` file in the handlers directory becomes one function. File path → route:

| File | Route |
|---|---|
| `index.ts` | `/` |
| `webhook.ts` | `/webhook` |
| `tg/[botId]/index.ts` | `/tg/{botId}` |

- `[param]` segments become `{param}` path parameters; they are available in the handler as `event.params` (an alias of `event.pathParameters`).
- Files and directories starting with `_` are ignored — use them for shared code imported by handlers.
- `.d.ts` files are ignored.
- Two files must not map to the same route or function name (e.g. `foo.ts` vs `foo/index.ts`); the build fails with an error naming both files.

A handler module must export a `handler` function (named export, or `default.handler`):

```ts
// handlers/webhook.ts
export async function handler(event: any, context: any) {
  return { statusCode: 200, body: 'ok' };
}
```

Uncaught handler errors are logged and mapped to a `500` response by the generated wrapper.

## Config file

Optional `functions-yc.config.json` in the project root, validated on load:

```json
{
  "appName": "my-app",
  "handlersDir": "handlers",
  "externalPackages": ["sharp"],
  "memory": 256,
  "timeout": 30,
  "cloudId": "...",
  "folderId": "...",
  "iamToken": "...",
  "storageAccessKey": "...",
  "storageSecretKey": "...",
  "stateBucket": "my-tf-state",
  "stateKey": "my-app/terraform.tfstate",
  "nodejsVersion": "nodejs20",
  "domainName": "api.example.com",
  "dnsZoneId": "...",
  "certificateId": "...",
  "createDnsZone": false,
  "zone": "ru-central1-a",
  "region": "ru-central1",
  "env": "production",
  "autoApprove": true,
  "deployBucketName": "my-app-deploy",
  "tfVars": { "some_var": "value" },
  "functionEnv": { "LOG_LEVEL": "info" }
}
```

All keys are optional. `functionEnv` entries are injected into every function's environment (plus `NODE_ENV=production`).

## Environment variables

| Variable | Maps to |
|---|---|
| `FYC_CLOUD_ID`, `FYC_FOLDER_ID`, `FYC_IAM_TOKEN` | cloud/folder/IAM token |
| `FYC_STORAGE_ACCESS_KEY`, `FYC_STORAGE_SECRET_KEY` | Object Storage keys |
| `FYC_STATE_BUCKET`, `FYC_STATE_KEY` | Terraform state bucket/key |
| `FYC_APP_NAME`, `FYC_ENV`, `FYC_NODEJS_VERSION` | app name / environment / runtime |
| `FYC_DOMAIN_NAME`, `FYC_DNS_ZONE_ID`, `FYC_CERTIFICATE_ID`, `FYC_CREATE_DNS_ZONE` | custom domain settings |
| `FYC_ZONE`, `FYC_REGION` | zone / region |
| `FYC_AUTO_APPROVE` | `true` to skip the Terraform approval prompt |
| `FYC_TF_VAR_<key>` | extra Terraform variable `<key>` (lowercased) |
| `FYC_FN_ENV_<KEY>` | function environment variable `<KEY>` (case preserved) |

Terraform S3 backend fallbacks (used when the `FYC_*`/CLI values are absent): `TF_STATE_BUCKET`, `TF_STATE_KEY`, `TF_STATE_ENDPOINT` (default `https://storage.yandexcloud.net`), `YC_REGION` (default `ru-central1`), and `YC_ACCESS_KEY`/`YC_SECRET_KEY` or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` for backend credentials.

## How deploy works

1. Build all handlers into zip artifacts plus `functions.manifest.json`.
2. Copy the embedded Terraform project to a temp directory and run `terraform init` (with the S3 backend when a state bucket/key is configured).
3. Resolve the deploy bucket: `--bucket`/config, or Terraform outputs; on first deploy, run a targeted apply that creates only the bucket.
4. Upload artifacts and the manifest to the deploy bucket.
5. Run the full `terraform apply` (functions, API Gateway, optional domain/DNS/certificate) and print the `api_gateway_url` output.

The temp Terraform directory is removed when the command finishes, including on failure.

## License

MIT
