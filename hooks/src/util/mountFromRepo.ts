// Distribution v2 mount-from-repo helper (F21).
//
// When AOCR's mirror has already fetched a private image's blobs into S3
// under `mirror/<host>/<repo>/blobs/<digest>`, copying them into the
// cluster-owned `_imported/...` path does NOT require re-uploading any
// bytes. Distribution's blob upload API supports a mount form:
//
//   POST /v2/<dst-repo>/blobs/uploads/?mount=<digest>&from=<src-repo>
//
// If the registry can locate the digest under `<src-repo>` (or anywhere in
// the underlying storage, since the digest is content-addressed), it
// returns 201 Created with a Location header pointing at the new blob
// reference in `<dst-repo>` — no bytes transferred. Falling back to a full
// upload would require streaming the layer, which defeats the point.
//
// The manifest itself is then PUT at the destination tag; the layer
// descriptors stay byte-identical (same digests).

export type ManifestDescriptor = {
  mediaType?: string;
  digest: string;
  size?: number;
  // OCI manifest indexes include additional fields we pass through unchanged.
  [k: string]: unknown;
};

export type Manifest = {
  schemaVersion: number;
  mediaType?: string;
  // Layers in image manifests; `manifests` in index/list manifests.
  config?: ManifestDescriptor;
  layers?: ManifestDescriptor[];
  manifests?: ManifestDescriptor[];
  [k: string]: unknown;
};

export type MountOutcome = {
  digest: string;
  // 'mounted' = 201 Created from the mount call (no bytes transferred).
  // 'present' = the destination repo already has this blob (treated as
  // success). 'failed' = could not be mounted; the caller should bail.
  status: 'mounted' | 'present' | 'failed';
  detail?: string;
};

export type MountAllResult = {
  outcomes: MountOutcome[];
  // True only when every layer + config blob mounted (or was already
  // present). The caller writes the manifest only on full success;
  // partial success leaves the destination repo without a manifest, so
  // nothing externally observable is created.
  allMounted: boolean;
};

export type MountFromRepoOptions = {
  // Base URL of the Distribution writer for the destination repo. For
  // AOCR's `mirror-writer` Pod this is `http://mirror-writer:5050`.
  registryUrl: string;
  // Optional auth header to send on every request (e.g. `Basic ...`).
  authorization?: string;
  // Per-request timeout.
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

export async function mountBlob(
  srcRepo: string,
  dstRepo: string,
  digest: string,
  opts: MountFromRepoOptions,
): Promise<MountOutcome> {
  const base = trimSlash(opts.registryUrl);
  const url = `${base}/v2/${dstRepo}/blobs/uploads/?mount=${encodeURIComponent(digest)}&from=${encodeURIComponent(srcRepo)}`;
  const headers: Record<string, string> = {};
  if (opts.authorization) headers['authorization'] = opts.authorization;

  let resp: Response;
  try {
    resp = await fetchWithTimeout(url, { method: 'POST', headers }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  } catch (err) {
    return { digest, status: 'failed', detail: `network error: ${(err as Error).message}` };
  }

  // Per the spec:
  //   201 Created → mounted successfully (Location: <new blob ref>)
  //   202 Accepted → mount did not happen; registry started a fresh upload
  //                  session (Location: <upload URL>). Means the source blob
  //                  wasn't found; the caller would have to stream bytes.
  //   404 → source repo or digest not found.
  //   401/403 → auth problem on the writer.
  if (resp.status === 201) {
    return { digest, status: 'mounted' };
  }
  if (resp.status === 202) {
    return { digest, status: 'failed', detail: 'mount declined; full upload would be required' };
  }
  if (resp.status === 404) {
    // Could be "destination repo doesn't exist yet" (Distribution accepts
    // implicit creation on first push) OR "source blob not found". Try a
    // HEAD against the destination to disambiguate — if the blob is
    // already present we treat it as success (idempotency).
    const headUrl = `${base}/v2/${dstRepo}/blobs/${encodeURIComponent(digest)}`;
    try {
      const head = await fetchWithTimeout(headUrl, { method: 'HEAD', headers }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      if (head.status === 200) return { digest, status: 'present' };
    } catch {
      // Fall through to the failure case below.
    }
    return { digest, status: 'failed', detail: 'source blob not found in registry' };
  }
  return { digest, status: 'failed', detail: `unexpected status ${resp.status}` };
}

// Mount every blob referenced by the manifest (config + layers, or each
// sub-manifest's digest for index/list types). Stops at the first hard
// failure; the returned `outcomes` array reflects what happened so far so
// the caller can log a precise reason.
export async function mountAllBlobs(
  manifest: Manifest,
  srcRepo: string,
  dstRepo: string,
  opts: MountFromRepoOptions,
): Promise<MountAllResult> {
  const digests = collectBlobDigests(manifest);
  const outcomes: MountOutcome[] = [];
  for (const digest of digests) {
    const outcome = await mountBlob(srcRepo, dstRepo, digest, opts);
    outcomes.push(outcome);
    if (outcome.status === 'failed') {
      return { outcomes, allMounted: false };
    }
  }
  return { outcomes, allMounted: true };
}

// PUT the manifest body at <dstRepo>:<tag>. Returns the digest the
// registry assigned (via the Docker-Content-Digest response header), which
// the caller logs for idempotency tracking.
export type WriteManifestResult = {
  digest: string | null;
  status: number;
  body: string | null;
};

export async function writeManifest(
  dstRepo: string,
  tag: string,
  manifestBody: string,
  mediaType: string,
  opts: MountFromRepoOptions,
): Promise<WriteManifestResult> {
  const base = trimSlash(opts.registryUrl);
  const url = `${base}/v2/${dstRepo}/manifests/${encodeURIComponent(tag)}`;
  const headers: Record<string, string> = { 'content-type': mediaType };
  if (opts.authorization) headers['authorization'] = opts.authorization;
  const resp = await fetchWithTimeout(
    url,
    { method: 'PUT', headers, body: manifestBody },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const digest = resp.headers.get('docker-content-digest');
  let body: string | null = null;
  try {
    body = await resp.text();
  } catch {
    // Empty body is fine on 201.
  }
  return { digest, status: resp.status, body };
}

// Inspect a manifest and produce the list of blob digests that need to
// exist in the destination repo. Image manifests reference `config` + each
// `layers[]`; index/list manifests reference each sub-`manifests[]` digest
// (which themselves must already be mountable — the source's image
// manifests are mounted as blobs in their own right under Distribution v2).
export function collectBlobDigests(manifest: Manifest): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (d: ManifestDescriptor | undefined) => {
    if (!d?.digest) return;
    if (seen.has(d.digest)) return;
    seen.add(d.digest);
    out.push(d.digest);
  };
  push(manifest.config);
  for (const layer of manifest.layers ?? []) push(layer);
  for (const sub of manifest.manifests ?? []) push(sub);
  return out;
}

function trimSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
