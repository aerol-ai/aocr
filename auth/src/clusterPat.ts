// Cluster IDs are operator-chosen labels, not UUIDs. This MUST stay in sync
// with the sandbox-library constraint on `SB_AUTO_IMPORT_CLUSTER_ID`
// (`^[A-Za-z0-9_-]{1,64}$`): the same string is the registry path segment
// (`cluster/<id>/...`) on the AerolVM push side and the namespace this PAT is
// scoped to here. UUIDs still match (they are a subset), so pre-existing
// UUID-keyed entries keep working. The character class is deliberately
// path-safe — anything outside it could break `cluster/<id>/` prefix matching
// in evaluateClusterPatScope.
const CLUSTER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface ClusterPatEntry {
  clusterId: string;
  token: string;
}

export interface ClusterPatScopeDecision {
  allowed: boolean;
  allowedActions: string[];
  reason?: string;
}

// Standard WASM module namespace. AerolVM stages curated language runtimes here
// (e.g. wasm/std/python) and references them fleet-wide by reserved keyword. It
// must be pull-only for every tenant cluster PAT (so any cluster can fetch the
// shared runtime) while remaining writable solely by the system/static PAT that
// publishes them. Configurable so an operator can relocate it; default tracks
// the `wasm.standard_modules` ref prefix on the AerolVM side. Kept in lockstep
// with the reaper's STANDARD_MODULE_NAMESPACE protection (hooks/imageRetention).
const DEFAULT_STANDARD_MODULE_NAMESPACE = 'wasm/std';

export function getStandardModuleNamespace(): string {
  const raw = (process.env['AOCR_WASM_STD_NAMESPACE'] || '').trim().replace(/\/+$/, '');
  return raw.length > 0 ? raw : DEFAULT_STANDARD_MODULE_NAMESPACE;
}

/**
 * Parse the AUTH_CLUSTER_PAT_TOKENS env value.
 *
 * Expected format: newline- or comma-separated entries of `<cluster_id>=<token>`,
 * where `<cluster_id>` matches `^[A-Za-z0-9_-]{1,64}$` (the AerolVM cluster
 * label; UUIDs are a valid subset). Malformed entries are skipped (with a
 * warning). If multiple entries share the same `<cluster_id>`, the last one wins.
 */
export function parseClusterPatEntries(rawValue: string | undefined): ClusterPatEntry[] {
  if (!rawValue) {
    return [];
  }

  const byClusterId = new Map<string, string>();

  for (const line of rawValue.split(/[\n,]/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
      console.warn('[cluster-pat] skipping malformed entry (expected <cluster_id>=<token>)');
      continue;
    }

    const clusterId = trimmed.slice(0, separatorIndex).trim();
    const token = trimmed.slice(separatorIndex + 1).trim();

    if (!CLUSTER_ID_PATTERN.test(clusterId)) {
      console.warn('[cluster-pat] skipping entry with invalid cluster_id (expected ^[A-Za-z0-9_-]{1,64}$)');
      continue;
    }

    if (!token) {
      continue;
    }

    if (byClusterId.has(clusterId)) {
      console.warn(`[cluster-pat] duplicate cluster_id ${clusterId}; using the last entry`);
    }

    byClusterId.set(clusterId, token);
  }

  return Array.from(byClusterId.entries()).map(([clusterId, token]) => ({ clusterId, token }));
}

/**
 * Cluster-class PAT scope policy:
 *   - repository:cluster/<clusterId>/...  -> all requested actions allowed (push + pull)
 *   - repository:mirror/...               -> read-only (pull) actions allowed; push silently dropped
 *   - repository:wasm/std/...             -> read-only (pull) actions allowed; push silently dropped
 *   - anything else                       -> rejected (allowed=false)
 */
export function evaluateClusterPatScope(
  clusterId: string,
  scopeType: string,
  scopeName: string,
  requestedActions: string[],
): ClusterPatScopeDecision {
  if (scopeType !== 'repository') {
    return { allowed: false, allowedActions: [], reason: 'cluster PAT supports only repository scope' };
  }

  if (!scopeName) {
    return { allowed: false, allowedActions: [], reason: 'cluster PAT requires a scope name' };
  }

  const ownNamespace = `cluster/${clusterId}`;
  if (scopeName === ownNamespace || scopeName.startsWith(`${ownNamespace}/`)) {
    return { allowed: true, allowedActions: [...requestedActions] };
  }

  if (scopeName === 'mirror' || scopeName.startsWith('mirror/')) {
    const readOnly = requestedActions.filter((action) => action === 'pull');
    return { allowed: true, allowedActions: readOnly };
  }

  const stdNamespace = getStandardModuleNamespace();
  if (scopeName === stdNamespace || scopeName.startsWith(`${stdNamespace}/`)) {
    const readOnly = requestedActions.filter((action) => action === 'pull');
    return { allowed: true, allowedActions: readOnly };
  }

  return {
    allowed: false,
    allowedActions: [],
    reason: `cluster PAT scope ${scopeName} is outside the cluster/${clusterId}, mirror/*, and ${stdNamespace}/* namespaces`,
  };
}
