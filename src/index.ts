#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs-extra';
import { Builder } from './build/index.js';
import { Uploader } from './upload/index.js';
import {
  cleanupTerraformProject,
  extractOutputString,
  prepareTerraformProject,
  resolveBackendConfig,
  TerraformRunner,
} from './terraform/index.js';

const program = new Command();

program
  .name('functions-yc')
  .description('Deploy TypeScript functions to Yandex Cloud')
  .version('1.0.0');

// ── Config loader ─────────────────────────────────────────────────────────────

interface FycConfig {
  appName?: string;
  handlersDir?: string;
  externalPackages?: string[];
  memory?: number;
  timeout?: number;
  cloudId?: string;
  folderId?: string;
  iamToken?: string;
  storageAccessKey?: string;
  storageSecretKey?: string;
  stateBucket?: string;
  stateKey?: string;
  nodejsVersion?: string;
  domainName?: string;
  env?: string;
  autoApprove?: boolean;
  deployBucketName?: string;
}

async function loadConfig(projectPath: string): Promise<FycConfig> {
  const configPath = path.join(projectPath, 'functions-yc.config.json');
  if (await fs.pathExists(configPath)) {
    return (await fs.readJson(configPath)) as FycConfig;
  }
  return {};
}

function e(key: string): string | undefined {
  return process.env[key] || undefined;
}

function first<T>(...values: (T | undefined)[]): T | undefined {
  return values.find((v) => v !== undefined);
}

function collectExternalPackages(cliValues: string[], config: FycConfig): string[] {
  if (cliValues.length > 0) return cliValues;
  if (Array.isArray(config.externalPackages)) return config.externalPackages as string[];
  return [];
}

// ── build ─────────────────────────────────────────────────────────────────────

program
  .command('build')
  .description('Scan handlers/, bundle with esbuild, write functions.manifest.json')
  .option('-p, --project <path>', 'Project root', '.')
  .option('-o, --output <path>', 'Output directory', '.fyc-out')
  .option('--handlers-dir <dir>', 'Handlers directory (relative to project)', '')
  .option('--app-name <name>', 'Application name')
  .option(
    '--external <pkg>',
    'Mark package external and copy from node_modules (repeatable)',
    (v: string, acc: string[]) => { acc.push(v); return acc; },
    [] as string[],
  )
  .option('--memory <mb>', 'Function memory in MB', '')
  .option('--timeout <s>', 'Function timeout in seconds', '')
  .option('-v, --verbose', 'Verbose output')
  .action(async (opts) => {
    try {
      const projectPath = path.resolve(opts.project as string);
      const outputDir = path.resolve(opts.output as string);
      const config = await loadConfig(projectPath);

      const builder = new Builder();
      const manifest = await builder.build({
        projectPath,
        outputDir,
        handlersDir:
          (opts.handlersDir as string) || config.handlersDir || 'handlers',
        appName: (opts.appName as string | undefined) || config.appName,
        externalPackages: collectExternalPackages(opts.external as string[], config),
        memory: opts.memory ? parseInt(opts.memory as string, 10) : config.memory,
        timeout: opts.timeout ? parseInt(opts.timeout as string, 10) : config.timeout,
        verbose: opts.verbose as boolean | undefined,
      });

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

program
  .command('deploy')
  .description('Build, upload artifacts, and run terraform apply')
  .option('-p, --project <path>', 'Project root', '.')
  .option('-o, --output <path>', 'Output directory', '.fyc-out')
  .option('--handlers-dir <dir>', 'Handlers directory (relative to project)', '')
  .option('--app-name <name>', 'Application name')
  .option(
    '--external <pkg>',
    'Mark package external and copy from node_modules (repeatable)',
    (v: string, acc: string[]) => { acc.push(v); return acc; },
    [] as string[],
  )
  .option('--memory <mb>', 'Function memory in MB', '')
  .option('--timeout <s>', 'Function timeout in seconds', '')
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
  .option('--env <env>', 'Environment (dev/staging/production)', '')
  .option('--auto-approve', 'Run terraform with -auto-approve')
  .option('-v, --verbose', 'Verbose output')
  .action(async (opts) => {
    const projectPath = path.resolve(opts.project as string);
    const outputDir = path.resolve(opts.output as string);
    const config = await loadConfig(projectPath);

    const cloudId = first(opts.cloudId as string | undefined, e('FYC_CLOUD_ID'), config.cloudId);
    const folderId = first(opts.folderId as string | undefined, e('FYC_FOLDER_ID'), config.folderId);
    const iamToken = first(opts.iamToken as string | undefined, e('FYC_IAM_TOKEN'), config.iamToken);
    const accessKey = first(opts.accessKey as string | undefined, e('FYC_STORAGE_ACCESS_KEY'), config.storageAccessKey);
    const secretKey = first(opts.secretKey as string | undefined, e('FYC_STORAGE_SECRET_KEY'), config.storageSecretKey);
    const stateBucket = first(opts.stateBucket as string | undefined, e('FYC_STATE_BUCKET'), config.stateBucket);
    const stateKey = first(opts.stateKey as string | undefined, e('FYC_STATE_KEY'), config.stateKey);
    const appName = first(opts.appName as string | undefined, e('FYC_APP_NAME'), config.appName);
    const nodejsVersion = first(
      opts.nodejsVersion ? (opts.nodejsVersion as string) : undefined,
      config.nodejsVersion,
      'nodejs20',
    );
    const environment = first(
      opts.env ? (opts.env as string) : undefined,
      config.env,
      'production',
    );
    const autoApprove =
      (opts.autoApprove as boolean | undefined) ||
      e('FYC_AUTO_APPROVE') === 'true' ||
      config.autoApprove ||
      false;
    const domainName = first(
      opts.domain as string | undefined,
      config.domainName,
    );

    const terraformDir = await prepareTerraformProject();

    try {
      // 1. Build
      const builder = new Builder();
      const manifest = await builder.build({
        projectPath,
        outputDir,
        handlersDir: (opts.handlersDir as string) || config.handlersDir || 'handlers',
        appName,
        externalPackages: collectExternalPackages(opts.external as string[], config),
        memory: opts.memory ? parseInt(opts.memory as string, 10) : config.memory,
        timeout: opts.timeout ? parseInt(opts.timeout as string, 10) : config.timeout,
        verbose: opts.verbose as boolean | undefined,
      });

      // 2. Terraform init
      const terraform = new TerraformRunner(terraformDir);
      const backend = resolveBackendConfig(
        { stateBucket, stateKey },
        {
          ...process.env,
          YC_REGION: 'ru-central1',
          YC_ACCESS_KEY: accessKey,
          YC_SECRET_KEY: secretKey,
        },
      );
      await terraform.init(backend || undefined);

      // 3. Upload
      const resolvedAccessKey = accessKey ?? '';
      const resolvedSecretKey = secretKey ?? '';

      if (!resolvedAccessKey || !resolvedSecretKey) {
        throw new Error(
          'Object Storage credentials required for upload. Provide --access-key/--secret-key or FYC_STORAGE_ACCESS_KEY/FYC_STORAGE_SECRET_KEY.',
        );
      }

      // Try to get existing bucket from terraform state, fall back to CLI/config
      let deployBucket = first(opts.bucket as string | undefined, config.deployBucketName);
      if (!deployBucket) {
        try {
          const outputs = await terraform.readOutputs();
          deployBucket = extractOutputString(outputs, 'deploy_bucket');
        } catch {
          // no state yet — bucket will be created by terraform
        }
      }

      const uploader = new Uploader();
      await uploader.upload({
        outputDir,
        manifest,
        bucket: deployBucket ?? `${(appName ?? path.basename(projectPath)).toLowerCase()}-${environment}-deploy`,
        accessKey: resolvedAccessKey,
        secretKey: resolvedSecretKey,
        verbose: opts.verbose as boolean | undefined,
      });

      // 4. Terraform apply
      const tfVarEnv: NodeJS.ProcessEnv = {
        ...process.env,
        TF_VAR_manifest_path: path.join(outputDir, 'functions.manifest.json'),
        TF_VAR_app_name: appName ?? path.basename(projectPath).toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        TF_VAR_env: environment,
        TF_VAR_nodejs_version: nodejsVersion,
      };

      if (cloudId) tfVarEnv['TF_VAR_cloud_id'] = cloudId;
      if (folderId) tfVarEnv['TF_VAR_folder_id'] = folderId;
      if (iamToken) tfVarEnv['TF_VAR_iam_token'] = iamToken;
      if (resolvedAccessKey) tfVarEnv['TF_VAR_storage_access_key'] = resolvedAccessKey;
      if (resolvedSecretKey) tfVarEnv['TF_VAR_storage_secret_key'] = resolvedSecretKey;
      if (deployBucket) tfVarEnv['TF_VAR_deploy_bucket_name'] = deployBucket;
      if (domainName) tfVarEnv['TF_VAR_domain_name'] = domainName;

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
      process.exit(1);
    } finally {
      await cleanupTerraformProject(terraformDir);
    }
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
