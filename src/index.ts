#!/usr/bin/env node

import { Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { Builder, type BuildOptions } from './build/index.js';
import { Uploader } from './upload/index.js';
import {
  cleanupTerraformProject,
  extractOutputString,
  prepareTerraformProject,
  resolveBackendConfig,
  TerraformRunner,
} from './terraform/index.js';
import { collectFunctionEnvFromEnv } from './function-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = fs.readJsonSync(path.join(__dirname, '..', 'package.json')) as {
  version: string;
};

const program = new Command();

program
  .name('functions-yc')
  .description('Deploy TypeScript functions to Yandex Cloud')
  .version(packageJson.version);

// ── Config loader ─────────────────────────────────────────────────────────────

const FycConfigSchema = z.object({
  appName: z.string().optional(),
  handlersDir: z.string().optional(),
  externalPackages: z.array(z.string()).optional(),
  memory: z.number().optional(),
  timeout: z.number().optional(),
  cloudId: z.string().optional(),
  folderId: z.string().optional(),
  iamToken: z.string().optional(),
  storageAccessKey: z.string().optional(),
  storageSecretKey: z.string().optional(),
  stateBucket: z.string().optional(),
  stateKey: z.string().optional(),
  nodejsVersion: z.string().optional(),
  domainName: z.string().optional(),
  dnsZoneId: z.string().optional(),
  certificateId: z.string().optional(),
  createDnsZone: z.boolean().optional(),
  zone: z.string().optional(),
  region: z.string().optional(),
  env: z.string().optional(),
  autoApprove: z.boolean().optional(),
  deployBucketName: z.string().optional(),
  tfVars: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  functionEnv: z.record(z.string(), z.string()).optional(),
});

type FycConfig = z.infer<typeof FycConfigSchema>;

async function loadConfig(projectPath: string): Promise<FycConfig> {
  const configPath = path.join(projectPath, 'functions-yc.config.json');
  if (!(await fs.pathExists(configPath))) {
    return {};
  }
  const raw: unknown = await fs.readJson(configPath);
  const parsed = FycConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid config file ${configPath}:\n${issues}`);
  }
  return parsed.data;
}

function e(key: string): string | undefined {
  return process.env[key] || undefined;
}

function first<T>(...values: (T | undefined)[]): T | undefined {
  return values.find((v) => v !== undefined);
}

function collectExternalPackages(cliValues: string[], config: FycConfig): string[] {
  if (cliValues.length > 0) return cliValues;
  if (Array.isArray(config.externalPackages)) return config.externalPackages;
  return [];
}

/** Collect FYC_TF_VAR_<key> env vars → { key: value } */
function collectTfVarsFromEnv(): Record<string, string> {
  const prefix = 'FYC_TF_VAR_';
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith(prefix) && v !== undefined) {
      result[k.slice(prefix.length).toLowerCase()] = v;
    }
  }
  return result;
}

/** Collect config.tfVars → { key: value } */
function collectTfVarsFromConfig(config: FycConfig): Record<string, string> {
  if (!config.tfVars) return {};
  return Object.fromEntries(
    Object.entries(config.tfVars).map(([k, v]) => [
      k.replace(/-/g, '_'),
      String(v),
    ]),
  );
}

/** TF vars the CLI manages itself; they cannot be overridden via --tf-var. */
const RESERVED_TF_VARS = new Set(['app_name', 'env', 'nodejs_version', 'cloud_id', 'folder_id']);

/** Parse --tf-var key=value assignments from CLI */
function parseTfVarAssignments(assignments: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const assignment of assignments) {
    const idx = assignment.indexOf('=');
    if (idx < 1) throw new Error(`--tf-var: expected key=value, got: ${assignment}`);
    const key = assignment.slice(0, idx).replace(/-/g, '_');
    if (RESERVED_TF_VARS.has(key)) {
      throw new Error(
        `--tf-var: "${key}" is managed by the CLI; use the dedicated option or FYC_* env var instead`,
      );
    }
    result[key] = assignment.slice(idx + 1);
  }
  return result;
}

const APP_NAME_RE = /^[a-z0-9][a-z0-9-]{1,29}[a-z0-9]$/;

/** Sanitize an app name for use in bucket/resource names and validate the result. */
function sanitizeAppName(name: string): string {
  const sanitized = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!APP_NAME_RE.test(sanitized)) {
    throw new Error(
      `Invalid app name "${name}" (sanitized: "${sanitized}"). ` +
        `It must be 3-31 characters of lowercase letters, digits and hyphens, ` +
        `starting and ending with a letter or digit (${APP_NAME_RE.source}).`,
    );
  }
  return sanitized;
}

// ── CLI options ───────────────────────────────────────────────────────────────

interface BuildCliOptions {
  project: string;
  output: string;
  handlersDir: string;
  appName?: string;
  external: string[];
  memory?: number;
  timeout?: number;
  verbose?: boolean;
}

interface DeployCliOptions extends BuildCliOptions {
  cloudId?: string;
  folderId?: string;
  iamToken?: string;
  accessKey?: string;
  secretKey?: string;
  bucket?: string;
  stateBucket?: string;
  stateKey?: string;
  nodejsVersion: string;
  domain?: string;
  dnsZoneId?: string;
  certificateId?: string;
  createDnsZone?: boolean;
  zone?: string;
  region?: string;
  env: string;
  tfVar: string[];
  autoApprove?: boolean;
}

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('Expected a positive integer.');
  }
  return parsed;
}

function collectRepeatable(value: string, acc: string[]): string[] {
  acc.push(value);
  return acc;
}

/** Options shared between `build` and `deploy`. */
function addBuildOptions(cmd: Command): Command {
  return cmd
    .option('-p, --project <path>', 'Project root', '.')
    .option('-o, --output <path>', 'Output directory', '.fyc-out')
    .option('--handlers-dir <dir>', 'Handlers directory (relative to project)', '')
    .option('--app-name <name>', 'Application name')
    .option(
      '--external <pkg>',
      'Mark package external and copy from node_modules (repeatable)',
      collectRepeatable,
      [] as string[],
    )
    .option('--memory <mb>', 'Function memory in MB', parsePositiveInt)
    .option('--timeout <s>', 'Function timeout in seconds', parsePositiveInt)
    .option('-v, --verbose', 'Verbose output');
}

/** Resolve CLI options + config into Builder.build() arguments. */
function resolveBuildArgs(
  opts: BuildCliOptions,
  config: FycConfig,
  appName: string | undefined,
): BuildOptions {
  return {
    projectPath: path.resolve(opts.project),
    outputDir: path.resolve(opts.output),
    handlersDir: opts.handlersDir || config.handlersDir || 'handlers',
    appName,
    externalPackages: collectExternalPackages(opts.external, config),
    memory: opts.memory ?? config.memory,
    timeout: opts.timeout ?? config.timeout,
    functionEnv: { ...config.functionEnv, ...collectFunctionEnvFromEnv() },
    verbose: opts.verbose,
  };
}

// ── build ─────────────────────────────────────────────────────────────────────

addBuildOptions(
  program
    .command('build')
    .description('Scan handlers/, bundle with esbuild, write functions.manifest.json'),
).action(async (opts: BuildCliOptions) => {
  try {
    const projectPath = path.resolve(opts.project);
    const config = await loadConfig(projectPath);

    const builder = new Builder();
    const manifest = await builder.build(
      resolveBuildArgs(opts, config, opts.appName || config.appName),
    );

    console.log(chalk.green(`\nBuild complete: ${manifest.functions.length} function(s)`));
    for (const fn of manifest.functions) {
      console.log(chalk.gray(`  ${fn.name}: ${fn.route}`));
    }
  } catch (error) {
    console.error(
      chalk.red('Build failed:'),
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  }
});

// ── deploy ────────────────────────────────────────────────────────────────────

addBuildOptions(
  program
    .command('deploy')
    .description('Build, upload artifacts, and run terraform apply'),
)
  .option('--cloud-id <id>', 'Yandex Cloud ID')
  .option('--folder-id <id>', 'Yandex Cloud Folder ID')
  .option('--iam-token <token>', 'Yandex Cloud IAM token')
  .option('--access-key <key>', 'Object Storage access key for upload')
  .option('--secret-key <key>', 'Object Storage secret key for upload')
  .option('--bucket <name>', 'Deploy bucket name')
  .option('--state-bucket <name>', 'Terraform S3 state bucket')
  .option('--state-key <key>', 'Terraform S3 state key')
  .option('--nodejs-version <ver>', 'Node.js version (nodejs18/nodejs20/nodejs22)', '')
  .option('--domain <name>', 'Custom domain name')
  .option('--dns-zone-id <id>', 'Existing DNS zone ID')
  .option('--certificate-id <id>', 'Existing TLS certificate ID')
  .option('--create-dns-zone', 'Create a new DNS zone for the domain')
  .option('--zone <zone>', 'Yandex Cloud availability zone')
  .option('--region <region>', 'Yandex Cloud region')
  .option('--env <env>', 'Environment (dev/staging/production)', '')
  .option(
    '--tf-var <key=value>',
    'Extra terraform variable (repeatable)',
    collectRepeatable,
    [] as string[],
  )
  .option('--auto-approve', 'Run terraform with -auto-approve')
  .action(async (opts: DeployCliOptions) => {
    let terraformDir: string | undefined;

    try {
      const projectPath = path.resolve(opts.project);
      const outputDir = path.resolve(opts.output);
      const config = await loadConfig(projectPath);

      // ── Resolve all options: CLI → env var → config ────────────────────────

      const cloudId       = first(opts.cloudId,       e('FYC_CLOUD_ID'),           config.cloudId);
      const folderId      = first(opts.folderId,      e('FYC_FOLDER_ID'),          config.folderId);
      const iamToken      = first(opts.iamToken,      e('FYC_IAM_TOKEN'),          config.iamToken);
      const accessKey     = first(opts.accessKey,     e('FYC_STORAGE_ACCESS_KEY'), config.storageAccessKey);
      const secretKey     = first(opts.secretKey,     e('FYC_STORAGE_SECRET_KEY'), config.storageSecretKey);
      const stateBucket   = first(opts.stateBucket,   e('FYC_STATE_BUCKET'),       config.stateBucket);
      const stateKey      = first(opts.stateKey,      e('FYC_STATE_KEY'),          config.stateKey);
      const appName       = first(opts.appName,       e('FYC_APP_NAME'),           config.appName);
      const domainName    = first(opts.domain,        e('FYC_DOMAIN_NAME'),        config.domainName);
      const dnsZoneId     = first(opts.dnsZoneId,     e('FYC_DNS_ZONE_ID'),        config.dnsZoneId);
      const certificateId = first(opts.certificateId, e('FYC_CERTIFICATE_ID'),     config.certificateId);
      const zone          = first(opts.zone,          e('FYC_ZONE'),               config.zone);
      const region        = first(opts.region,        e('FYC_REGION'),             config.region);

      const createDnsZone =
        opts.createDnsZone ||
        e('FYC_CREATE_DNS_ZONE') === 'true' ||
        config.createDnsZone ||
        false;

      const nodejsVersion = first(
        opts.nodejsVersion || undefined,
        e('FYC_NODEJS_VERSION'),
        config.nodejsVersion,
        'nodejs18',
      )!;

      const environment = first(
        opts.env || undefined,
        e('FYC_ENV'),
        config.env,
        'production',
      )!;

      const autoApprove =
        opts.autoApprove ||
        e('FYC_AUTO_APPROVE') === 'true' ||
        config.autoApprove ||
        false;

      // Validate the app name early: it feeds bucket and resource names.
      const tfAppName = sanitizeAppName(appName ?? path.basename(projectPath));

      // Fail fast: uploads need Object Storage credentials.
      if (!accessKey || !secretKey) {
        throw new Error(
          'Object Storage credentials required for upload. Provide --access-key/--secret-key or FYC_STORAGE_ACCESS_KEY/FYC_STORAGE_SECRET_KEY.',
        );
      }

      // ── Custom terraform vars: config → env → CLI (later wins) ─────────────

      const extraTfVars: Record<string, string> = {
        ...collectTfVarsFromConfig(config),
        ...collectTfVarsFromEnv(),
        ...parseTfVarAssignments(opts.tfVar),
      };

      // ── Deploy ─────────────────────────────────────────────────────────────

      terraformDir = await prepareTerraformProject();

      // 1. Build
      const builder = new Builder();
      const manifest = await builder.build(resolveBuildArgs(opts, config, appName));

      // 2. Terraform init
      const terraform = new TerraformRunner(terraformDir);
      const backend = resolveBackendConfig(
        { stateBucket, stateKey },
        {
          ...process.env,
          YC_REGION: region ?? 'ru-central1',
          YC_ACCESS_KEY: accessKey,
          YC_SECRET_KEY: secretKey,
        },
      );
      await terraform.init(backend || undefined);

      const tfVarEnv: NodeJS.ProcessEnv = {
        ...process.env,
        // Extra terraform vars (FYC_TF_VAR_* / config.tfVars / --tf-var)
        ...Object.fromEntries(
          Object.entries(extraTfVars).map(([k, v]) => [`TF_VAR_${k}`, v]),
        ),
        // CLI-managed vars always win over extra terraform vars
        TF_VAR_manifest_path: path.join(outputDir, 'functions.manifest.json'),
        TF_VAR_app_name: tfAppName,
        TF_VAR_env: environment,
        TF_VAR_nodejs_version: nodejsVersion,
      };

      if (cloudId)       tfVarEnv['TF_VAR_cloud_id']           = cloudId;
      if (folderId)      tfVarEnv['TF_VAR_folder_id']          = folderId;
      if (iamToken)      tfVarEnv['TF_VAR_iam_token']          = iamToken;
      tfVarEnv['TF_VAR_storage_access_key'] = accessKey;
      tfVarEnv['TF_VAR_storage_secret_key'] = secretKey;
      if (domainName)    tfVarEnv['TF_VAR_domain_name']        = domainName;
      if (dnsZoneId)     tfVarEnv['TF_VAR_dns_zone_id']        = dnsZoneId;
      if (certificateId) tfVarEnv['TF_VAR_certificate_id']     = certificateId;
      if (zone)          tfVarEnv['TF_VAR_zone']               = zone;
      if (region)        tfVarEnv['TF_VAR_region']             = region;
      tfVarEnv['TF_VAR_create_dns_zone'] = String(createDnsZone);

      // 3. Ensure deploy bucket exists before uploading artifacts
      let deployBucket = first(opts.bucket, config.deployBucketName);
      if (!deployBucket) {
        try {
          const outputs = await terraform.readOutputs(tfVarEnv);
          deployBucket = extractOutputString(outputs, 'deploy_bucket');
        } catch (error) {
          // Likely no state yet (first deploy). readOutputs already treats
          // "No outputs found" as empty, so surface anything else in verbose mode.
          if (opts.verbose) {
            console.error(
              chalk.gray(
                `  Could not read terraform outputs: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          }
        }
      }

      if (!deployBucket) {
        // First deploy: create the bucket before uploading
        await terraform.apply({
          autoApprove,
          env: tfVarEnv,
          targets: ['yandex_storage_bucket.deploy'],
        });
        const outputs = await terraform.readOutputs(tfVarEnv);
        deployBucket = extractOutputString(outputs, 'deploy_bucket');
        if (!deployBucket) {
          throw new Error(
            'Terraform did not report a "deploy_bucket" output after the targeted apply; cannot resolve the deploy bucket.',
          );
        }
      }

      tfVarEnv['TF_VAR_deploy_bucket_name'] = deployBucket;

      // 4. Upload artifacts
      const uploader = new Uploader();
      await uploader.upload({
        outputDir,
        manifest,
        bucket: deployBucket,
        accessKey,
        secretKey,
        verbose: opts.verbose,
      });

      // 5. Full terraform apply
      await terraform.apply({ autoApprove, env: tfVarEnv });

      // Print outputs
      const outputs = await terraform.readOutputs(tfVarEnv);
      const url = extractOutputString(outputs, 'api_gateway_url');
      if (url) {
        console.log(chalk.green(`\nDeploy complete: ${url}`));
      } else {
        console.log(chalk.green('\nDeploy complete'));
      }
    } catch (error) {
      console.error(
        chalk.red('Deploy failed:'),
        error instanceof Error ? error.message : String(error),
      );
      process.exitCode = 1;
    } finally {
      if (terraformDir) {
        await cleanupTerraformProject(terraformDir);
      }
    }
  });

await program.parseAsync(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
