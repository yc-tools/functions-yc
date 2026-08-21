/**
 * Collect FYC_FN_ENV_<KEY> env vars → { KEY: value } (keys keep original case).
 *
 * Empty values are dropped: Yandex Cloud rejects them outright ("Illegal value
 * of environment variable"), and because the provider reports that as a
 * warning the whole deploy then succeeds without publishing a version. CI
 * commonly passes an unset variable through as '', so this is the normal case,
 * not a misconfiguration worth failing on — but say so, since dropping a key
 * leaves whatever the previous deploy set.
 */
export function collectFunctionEnvFromEnv(): Record<string, string> {
  const prefix = 'FYC_FN_ENV_';
  const result: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith(prefix) || v === undefined) continue;
    const key = k.slice(prefix.length);
    if (v.trim() === '') {
      dropped.push(key);
      continue;
    }
    result[key] = v;
  }
  if (dropped.length > 0) {
    console.warn(
      `Ignoring empty function environment ${dropped.length === 1 ? 'variable' : 'variables'}: ${dropped.join(', ')}. ` +
        'Yandex Cloud rejects empty values; any value set by a previous deploy is left in place.',
    );
  }
  return result;
}
