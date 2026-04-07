import fs from 'fs-extra';
import path from 'path';
import archiver from 'archiver';
import chalk from 'chalk';
import ora from 'ora';
import * as esbuild from 'esbuild';
import { glob } from 'glob';

export interface FunctionEntry {
  name: string;
  zipPath: string;
  entry: string;
  route: string;
  params: string[];
  memory: number;
  timeout: number;
  env: Record<string, string>;
}

export interface FunctionsManifest {
  appName: string;
  buildId: string;
  timestamp: string;
  functions: FunctionEntry[];
}

export interface BuildOptions {
  projectPath: string;
  outputDir: string;
  handlersDir?: string;
  appName?: string;
  buildId?: string;
  externalPackages?: string[];
  memory?: number;
  timeout?: number;
  verbose?: boolean;
}

export class Builder {
  async build(options: BuildOptions): Promise<FunctionsManifest> {
    const {
      projectPath,
      outputDir,
      handlersDir = 'handlers',
      externalPackages = [],
      memory = 256,
      timeout = 30,
      verbose,
    } = options;

    const spinner = ora();
    const artifactsDir = path.join(outputDir, 'artifacts');
    await fs.ensureDir(artifactsDir);

    const buildId = options.buildId ?? generateBuildId();
    const appName = options.appName ?? path.basename(projectPath);

    // Scan handlers
    const handlersAbsDir = path.resolve(projectPath, handlersDir);
    if (!(await fs.pathExists(handlersAbsDir))) {
      throw new Error(`Handlers directory not found: ${handlersAbsDir}`);
    }

    spinner.start('Scanning handlers...');
    const handlerFiles = await glob('**/*.ts', { cwd: handlersAbsDir, absolute: false });

    if (handlerFiles.length === 0) {
      throw new Error(`No .ts files found in: ${handlersAbsDir}`);
    }
    spinner.succeed(`Found ${handlerFiles.length} handler(s)`);

    // Build each handler
    const functions: FunctionEntry[] = [];
    const tempDir = path.join(outputDir, '.tmp-build');
    await fs.ensureDir(tempDir);

    try {
      for (const relFile of handlerFiles.sort()) {
        const route = filePathToRoute(relFile);
        const params = extractRouteParams(route);
        const name = routeToFunctionName(route);

        if (verbose) {
          console.log(chalk.gray(`  ${relFile} → ${route}`));
        }

        const entryAbsolute = path.join(handlersAbsDir, relFile);
        const wrapperPath = path.join(tempDir, `${name}-entry.cjs`);
        const distPath = path.join(tempDir, `${name}-bundle.cjs`);
        const zipPath = path.join(artifactsDir, `${name}.zip`);

        await fs.writeFile(wrapperPath, generateWrapper(entryAbsolute));

        spinner.start(`Bundling ${name}...`);
        await esbuild.build({
          entryPoints: [wrapperPath],
          bundle: true,
          platform: 'node',
          target: 'node20',
          format: 'cjs',
          outfile: distPath,
          minify: true,
          treeShaking: true,
          logLevel: 'warning',
          external: externalPackages,
        });

        if (externalPackages.length > 0) {
          await zipBundleWithNodeModules(distPath, projectPath, externalPackages, zipPath);
        } else {
          await zipFile(distPath, zipPath, 'index.js');
        }

        functions.push({
          name,
          zipPath: path.relative(outputDir, zipPath),
          entry: 'index.handler',
          route,
          params,
          memory,
          timeout,
          env: { NODE_ENV: 'production' },
        });

        spinner.succeed(`Built ${name} → ${route}`);
      }
    } finally {
      await fs.remove(tempDir);
    }

    const manifest: FunctionsManifest = {
      appName,
      buildId,
      timestamp: new Date().toISOString(),
      functions,
    };

    const manifestPath = path.join(outputDir, 'functions.manifest.json');
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    if (verbose) {
      console.log(chalk.gray(`  Manifest: ${manifestPath}`));
    }

    return manifest;
  }
}

/**
 * Convert a file path (relative to handlers/) to an API route.
 *
 * tg/[botId]/index.ts → /tg/{botId}
 * webhook.ts          → /webhook
 * index.ts            → /
 */
export function filePathToRoute(filePath: string): string {
  let p = filePath.replace(/\\/g, '/');
  p = p.replace(/\.ts$/, '');
  p = p.replace(/\/index$/, '');
  if (p === '' || p === 'index') return '/';
  p = p.replace(/\[([^\]]+)\]/g, '{$1}');
  if (!p.startsWith('/')) p = '/' + p;
  return p;
}

/**
 * Extract path parameter names from a route.
 * /tg/{botId} → ['botId']
 */
export function extractRouteParams(route: string): string[] {
  const params: string[] = [];
  const re = /\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(route)) !== null) {
    params.push(m[1]);
  }
  return params;
}

/**
 * Convert a route to a valid terraform resource name.
 * /tg/{botId} → tg-botId
 * /           → root
 */
export function routeToFunctionName(route: string): string {
  return (
    route
      .replace(/^\//, '')
      .replace(/\{([^}]+)\}/g, '$1')
      .replace(/\//g, '-')
      .replace(/[^a-zA-Z0-9-]/g, '')
      .toLowerCase() || 'root'
  );
}

function generateWrapper(entryAbsolutePath: string): string {
  const escaped = JSON.stringify(entryAbsolutePath);
  return `'use strict';
const _mod = require(${escaped});
const _handler = _mod.handler || _mod.default?.handler;
exports.handler = async (event, context) => {
  event.params = event.pathParameters || {};
  return _handler(event, context);
};
`;
}

function generateBuildId(): string {
  return new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
}

async function zipFile(sourcePath: string, destZip: string, entryName: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(destZip);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.file(sourcePath, { name: entryName });
    void archive.finalize();
  });
}

async function zipBundleWithNodeModules(
  bundlePath: string,
  projectPath: string,
  externals: string[],
  destZip: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(destZip);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.file(bundlePath, { name: 'index.js' });
    for (const pkg of externals) {
      const pkgDir = path.join(projectPath, 'node_modules', pkg);
      archive.directory(pkgDir, `node_modules/${pkg}`);
    }
    void archive.finalize();
  });
}
