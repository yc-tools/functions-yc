import fs from 'fs-extra';
import path from 'path';
import { createRequire } from 'module';
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
  const closure = collectPackageClosure(externals, projectPath);

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(destZip);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.file(bundlePath, { name: 'index.js' });
    for (const [name, dir] of closure) {
      archive.directory(dir, `node_modules/${name}`);
    }
    archive.finalize().catch(reject);
  });
}

/**
 * Resolve each external package *and everything it requires at runtime*.
 *
 * Shipping only the named packages leaves the function with a top-level
 * dependency whose own imports are missing, and it fails at the first
 * `require` — as a MODULE_NOT_FOUND from inside node_modules, far from
 * anything the author wrote. Node's resolver is used so both npm's hoisted
 * layout and pnpm's `.pnpm` symlink farm work; the result is flattened into a
 * single node_modules directory, which is what the function runtime expects.
 */
export function collectPackageClosure(
  externals: string[],
  projectPath: string,
): Map<string, string> {
  const require = createRequire(path.join(projectPath, 'package.json'));
  const resolved = new Map<string, string>();
  const queue: Array<{ name: string; from: string }> = externals.map((name) => ({
    name,
    from: projectPath,
  }));

  while (queue.length > 0) {
    const { name, from } = queue.shift()!;
    const dir = resolvePackageDir(require, name, from);

    if (!dir) {
      // A named external that cannot be found is a configuration error; a
      // missing transitive dependency is usually an unmet optional one.
      if (externals.includes(name)) {
        throw new Error(`External package "${name}" not found in node_modules under ${projectPath}`);
      }
      continue;
    }

    const existing = resolved.get(name);
    if (existing) {
      if (existing !== dir) {
        console.warn(
          `Two versions of "${name}" are required (${existing} and ${dir}); bundling the first. ` +
            'Flattening cannot represent both.',
        );
      }
      continue;
    }
    resolved.set(name, dir);

    for (const dep of readRuntimeDependencies(dir)) {
      if (!resolved.has(dep)) queue.push({ name: dep, from: dir });
    }
  }

  return resolved;
}

function resolvePackageDir(
  require: NodeJS.Require,
  name: string,
  fromDir: string,
): string | null {
  try {
    return realpath(path.dirname(require.resolve(`${name}/package.json`, { paths: [fromDir] })));
  } catch {
    // Packages with an "exports" map may refuse to expose package.json, so
    // fall back to walking node_modules the way Node itself would.
  }

  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.pathExistsSync(path.join(candidate, 'package.json'))) return realpath(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve symlinks before looking further. pnpm links every dependency into a
 * `.pnpm` store, and a package's own dependencies are siblings inside that
 * store — invisible if the search starts from the link in the project's
 * node_modules.
 */
function realpath(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * Everything a package may require at runtime: dependencies, plus optional and
 * peer dependencies when they are actually installed.
 *
 * Peers matter because a library commonly reaches into one lazily — ydb-sdk
 * requires '@yandex-cloud/nodejs-sdk/dist/token-service/metadata-token-service'
 * only when metadata auth is used, so omitting installed peers produces a
 * function that starts fine and fails on the first authenticated call.
 * Unresolvable entries are dropped later, so listing a peer the consumer chose
 * not to install costs nothing.
 */
function readRuntimeDependencies(pkgDir: string): string[] {
  try {
    const manifest = fs.readJsonSync(path.join(pkgDir, 'package.json')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    return [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ];
  } catch {
    return [];
  }
}
