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
  functionEnv?: Record<string, string>;
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
      functionEnv = {},
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
    const handlerFiles = await glob('**/*.ts', {
      cwd: handlersAbsDir,
      absolute: false,
      ignore: ['**/*.d.ts', '**/_*', '**/_*/**'],
    });

    if (handlerFiles.length === 0) {
      throw new Error(`No .ts files found in: ${handlersAbsDir}`);
    }
    spinner.succeed(`Found ${handlerFiles.length} handler(s)`);
    handlerFiles.sort();
    assertNoCollisions(handlerFiles);

    // Build each handler
    const functions: FunctionEntry[] = [];
    const tempDir = path.join(outputDir, '.tmp-build');
    await fs.ensureDir(tempDir);

    try {
      for (const relFile of handlerFiles) {
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
          env: { NODE_ENV: 'production', ...functionEnv },
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
 * Fail fast when two handler files map to the same route or function name
 * (e.g. `foo.ts` vs `foo/index.ts` → same route; `/a-b` vs `/a/b` → same name).
 */
function assertNoCollisions(handlerFiles: string[]): void {
  const byRoute = new Map<string, string>();
  const byName = new Map<string, string>();

  for (const relFile of handlerFiles) {
    const route = filePathToRoute(relFile);
    const name = routeToFunctionName(route);

    const routeOwner = byRoute.get(route);
    if (routeOwner) {
      throw new Error(
        `Route collision: "${routeOwner}" and "${relFile}" both map to route "${route}". Rename or remove one of them.`,
      );
    }
    byRoute.set(route, relFile);

    const nameOwner = byName.get(name);
    if (nameOwner) {
      throw new Error(
        `Function name collision: "${nameOwner}" and "${relFile}" both map to function name "${name}". Rename or remove one of them.`,
      );
    }
    byName.set(name, relFile);
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
let _handler;
try {
  const _mod = require(${escaped});
  _handler = _mod.handler || _mod.default?.handler;
  if (typeof _handler !== 'function') {
    throw new Error('No exported handler function found in module');
  }
} catch (initErr) {
  console.error('[functions-yc] Module init error:', initErr);
  _handler = async () => ({ statusCode: 500, body: 'Internal Server Error: module init failed' });
}
exports.handler = async (event, context) => {
  event.params = event.pathParameters || {};
  try {
    return await _handler(event, context);
  } catch (err) {
    console.error('[functions-yc] Handler error:', err);
    return { statusCode: 500, body: 'Internal Server Error' };
  }
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
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.file(sourcePath, { name: entryName });
    archive.finalize().catch(reject);
  });
}

async function zipBundleWithNodeModules(
  bundlePath: string,
  projectPath: string,
  externals: string[],
  destZip: string,
): Promise<void> {
  for (const pkg of externals) {
    const pkgDir = path.join(projectPath, 'node_modules', pkg);
    if (!(await fs.pathExists(pkgDir))) {
      throw new Error(`External package "${pkg}" not found in node_modules: ${pkgDir}`);
    }
  }

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(destZip);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.file(bundlePath, { name: 'index.js' });
    for (const pkg of externals) {
      const pkgDir = path.join(projectPath, 'node_modules', pkg);
      archive.directory(pkgDir, `node_modules/${pkg}`);
    }
    archive.finalize().catch(reject);
  });
}
