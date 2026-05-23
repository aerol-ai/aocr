const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClusterPatEntry {
  clusterId: string;
  token: string;
}

export interface ClusterPatScopeDecision {
  allowed: boolean;
  allowedActions: string[];
  reason?: string;
}

/**
 * Parse the AUTH_CLUSTER_PAT_TOKENS env value.
 *
 * Expected format: newline- or comma-separated entries of `<cluster_id>=<token>`,
 * where `<cluster_id>` is a UUID. Malformed entries are skipped (with a warning).
 * If multiple entries share the same `<cluster_id>`, the last one wins.
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

    if (!UUID_PATTERN.test(clusterId)) {
      console.warn('[cluster-pat] skipping entry with non-UUID cluster_id');
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

  return {
    allowed: false,
    allowedActions: [],
    reason: `cluster PAT scope ${scopeName} is outside the cluster/${clusterId} and mirror/* namespaces`,
  };
}
