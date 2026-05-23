// F18: Proof-of-access cache.
//
// When a user pulls a 200-layer image through the mirror, the auth service
// would otherwise re-run the full upstream token exchange + manifest probe
// once per layer. Instead, the first successful probe inserts a "proof" into
// this cache, and subsequent pulls (within the TTL, same upstream creds)
// reuse both the upstream bearer and the validated scope list.
//
// Key: sha256(upstream_host || username || password) — see credIdentity in
// wrap.ts. NOTE the cache key does NOT include the scope: a user with one
// set of creds pulling many repos shares a single proof entry, and the entry
// accumulates scoped_repos as each repo is probed.
//
// Bounded LRU. On capacity overflow or TTL expiry the entry is dropped and
// the upstream bearer buffer is overwritten so it does not linger in the GC
// heap any longer than necessary. (Best-effort — Node strings are immutable,
// so we store the bearer in a Buffer that we can zero on eviction.)

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

export type ProofEntry = {
  // Identity hash from credIdentity(creds) — duplicated here so the caller
  // does not need to recompute when invalidating.
  identity: string;
  // When the proof was minted (Date.now()).
  provenAt: number;
  // When the proof expires; entries past this are treated as missing.
  expiresAt: number;
  // The upstream registry bearer token from the probe. Kept in a Buffer so
  // we can overwrite the bytes on eviction.
  upstreamBearer: Buffer;
  // Repos that have been confirmed reachable with this proof. Each
  // additional repo gets added on a successful HEAD; the set is consulted
  // by callers before re-probing.
  scopedRepos: Set<string>;
};

// What we hand back to callers — bearer as a string for ergonomics, but the
// caller MUST treat it as ephemeral and not retain it past the request.
export type ProofLookup = {
  upstreamBearer: string;
  scopedRepos: Set<string>;
  provenAt: Date;
  expiresAt: Date;
};

export type ProofCacheOptions = {
  ttlMs?: number;
  maxEntries?: number;
  // Injectable clock for tests.
  now?: () => number;
};

export class ProofCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  // Map iteration order in JS is insertion order, which gives us LRU for
  // free: on access we delete + re-insert to move the entry to the tail; on
  // overflow we delete the head (= least recently used).
  private readonly entries: Map<string, ProofEntry> = new Map();

  constructor(opts: ProofCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Look up a proof by credential identity. Returns null on miss, on
   * expiry, or if the proof exists but does not include the requested repo
   * in its scoped_repos set — in the last case the caller should re-probe
   * the upstream for that specific repo and then call recordScope().
   *
   * `repo` is the upstream-side repo path (e.g. "library/redis"), not the
   * Distribution scope string.
   */
  get(identity: string, repo: string): ProofLookup | null {
    const entry = this.entries.get(identity);
    if (!entry) return null;
    if (this.now() >= entry.expiresAt) {
      this.evict(identity);
      return null;
    }
    if (!entry.scopedRepos.has(repo)) {
      // Proof exists for these creds but not for this repo. Caller probes
      // upstream, then calls recordScope() to widen the set.
      return null;
    }
    // Mark as most-recently-used by re-inserting at the tail.
    this.entries.delete(identity);
    this.entries.set(identity, entry);
    return {
      upstreamBearer: entry.upstreamBearer.toString('utf8'),
      scopedRepos: new Set(entry.scopedRepos),
      provenAt: new Date(entry.provenAt),
      expiresAt: new Date(entry.expiresAt),
    };
  }

  /**
   * Record a successful probe. If an entry already exists for this
   * identity, its scoped_repos set is widened and its upstream bearer is
   * refreshed (the new bearer is likely identical, but adapters may rotate
   * — we trust the most recent probe). The expiry resets to now + ttl.
   */
  record(identity: string, repo: string, upstreamBearer: string): void {
    const existing = this.entries.get(identity);
    if (existing) {
      existing.scopedRepos.add(repo);
      // Overwrite old bearer bytes before replacing the buffer.
      existing.upstreamBearer.fill(0);
      existing.upstreamBearer = Buffer.from(upstreamBearer, 'utf8');
      existing.expiresAt = this.now() + this.ttlMs;
      this.entries.delete(identity);
      this.entries.set(identity, existing);
      return;
    }
    const now = this.now();
    const entry: ProofEntry = {
      identity,
      provenAt: now,
      expiresAt: now + this.ttlMs,
      upstreamBearer: Buffer.from(upstreamBearer, 'utf8'),
      scopedRepos: new Set([repo]),
    };
    this.entries.set(identity, entry);
    this.enforceCapacity();
  }

  /**
   * Add a repo to an existing proof's scope without changing the bearer or
   * resetting the TTL. Useful when the caller did its own probe and just
   * wants to widen the cached set. No-op if no entry exists.
   */
  recordScope(identity: string, repo: string): void {
    const entry = this.entries.get(identity);
    if (!entry) return;
    entry.scopedRepos.add(repo);
  }

  /**
   * Drop a proof entry. Call this on upstream 401: the cached bearer is no
   * longer trusted, the user must re-authenticate. Zeroes the bearer bytes.
   */
  invalidate(identity: string): void {
    this.evict(identity);
  }

  /**
   * Test/diagnostic helper. Not for production use.
   */
  size(): number {
    return this.entries.size;
  }

  private evict(identity: string): void {
    const entry = this.entries.get(identity);
    if (!entry) return;
    entry.upstreamBearer.fill(0);
    this.entries.delete(identity);
  }

  private enforceCapacity(): void {
    while (this.entries.size > this.maxEntries) {
      // Map.keys() iterates in insertion order → first key is LRU.
      const lru = this.entries.keys().next().value;
      if (lru === undefined) return;
      this.evict(lru);
    }
  }
}
