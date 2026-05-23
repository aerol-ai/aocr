import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import crypto from 'crypto';
import {
  ClusterPatEntry,
  evaluateClusterPatScope,
  parseClusterPatEntries,
} from './clusterPat';
import { WrapKeyRing, parseWrapKeyRing } from './upstreamAuth/wrap';
import { ProofCache } from './upstreamAuth/proofCache';
import {
  WRAPPED_UPSTREAM_TOKEN_TTL_SECONDS,
  isWrappedUpstreamToken,
  validateWrappedUpstream,
} from './upstreamAuth/strategy';
import {
  bindMetricsPool,
  elapsedSecondsSince,
  mountMetrics,
  recordDatabaseSync,
  recordTokenIssuance,
  recordTokenValidation,
  recordUpstreamValidation,
  setConfiguredClusterPatCount,
  setConfiguredPatCount,
} from './metrics';
import {
  listAllImages,
  listImagesForExternalId,
  parseLimit,
  parseOffset,
} from './imageList';

function computeLibtrustKeyId(privateKeyPem: string): string {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const publicKey = crypto.createPublicKey(privateKey);
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const hash = crypto.createHash('sha256').update(spkiDer).digest();
  const truncated = hash.slice(0, 30);

  const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let result = '';
  let bits = 0;
  let value = 0;
  for (let i = 0; i < truncated.length; i++) {
    value = (value << 8) | truncated[i];
    bits += 8;
    while (bits >= 5) {
      result += base32chars[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    result += base32chars[(value << (5 - bits)) & 31];
  }
  return (result.match(/.{1,4}/g) || []).join(':');
}

const app = express();
const port = process.env.PORT || 8080;

function getDatabaseConnectionString(): string {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  const host = process.env.POSTGRES_HOST;
  const database = process.env.POSTGRES_DB;
  const user = process.env.POSTGRES_USER;
  const password = process.env.POSTGRES_PASSWORD;
  const dbPort = process.env.POSTGRES_PORT || '5432';

  if (!host || !database || !user || !password) {
    throw new Error('DATABASE_URL or POSTGRES_HOST/POSTGRES_DB/POSTGRES_USER/POSTGRES_PASSWORD must be configured');
  }

  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${dbPort}/${database}`;
}

const pool = new Pool({
  connectionString: getDatabaseConnectionString(),
});
bindMetricsPool(pool);

const VALIDATION_SERVICE_URL = process.env.VALIDATION_SERVICE_URL;
const AUTH_PAT_TOKEN = process.env.AUTH_PAT_TOKEN;
const AUTH_PAT_TOKENS = process.env.AUTH_PAT_TOKENS;
const AUTH_CLUSTER_PAT_TOKENS = process.env.AUTH_CLUSTER_PAT_TOKENS;
const JWT_PRIVATE_KEY = process.env.JWT_PRIVATE_KEY?.replace(/\\n/g, '\n');
const ISSUER = 'aocr-auth';
const DEFAULT_REGISTRY_SERVICE = process.env.REGISTRY_SERVICE || 'aocr';
const STATIC_PAT_SUBJECT = 'static-pat';
const STATIC_PAT_PROVIDER = 'static-pat';
const CLUSTER_PAT_PROVIDER = 'cluster-pat';
const WRAPPED_UPSTREAM_PROVIDER = 'wrapped-upstream';

app.use(express.json());
mountMetrics(app);

interface ValidationUserProfile {
  externalId: string;
  username: string | null;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  authProvider: string | null;
  rawProfile: Record<string, unknown>;
}

interface StaticPatConfig {
  tokens: string[];
  userProfile: ValidationUserProfile;
}

interface ClusterPatConfig {
  entries: ClusterPatEntry[];
}

interface ValidationResult {
  strategy: 'api' | 'pat' | 'cluster-pat' | 'wrapped-upstream';
  userProfile: ValidationUserProfile;
  clusterId?: string;
  // Present only when strategy === 'wrapped-upstream'. Identifies the
  // upstream creds without exposing them — used as the JWT sub and for
  // metrics correlation. The auth service NEVER logs the cleartext creds.
  credIdentity?: string;
}

function parseStaticPatTokens(...rawValues: Array<string | undefined>): string[] {
  const seen = new Set<string>();

  for (const rawValue of rawValues) {
    if (!rawValue) {
      continue;
    }

    for (const token of rawValue.split(/[\n,]/)) {
      const trimmedToken = token.trim();
      if (!trimmedToken || seen.has(trimmedToken)) {
        continue;
      }

      seen.add(trimmedToken);
    }
  }

  return Array.from(seen);
}

function getStaticPatConfig(): StaticPatConfig | null {
  const tokens = parseStaticPatTokens(AUTH_PAT_TOKEN, AUTH_PAT_TOKENS);
  if (tokens.length === 0) {
    return null;
  }

  const userProfile: ValidationUserProfile = {
    externalId: STATIC_PAT_SUBJECT,
    username: null,
    email: null,
    displayName: STATIC_PAT_SUBJECT,
    avatarUrl: null,
    authProvider: STATIC_PAT_PROVIDER,
    rawProfile: {
      source: 'static-pat',
      user: {
        id: STATIC_PAT_SUBJECT,
      },
      authProvider: STATIC_PAT_PROVIDER,
    },
  };

  return {
    tokens,
    userProfile,
  };
}

const STATIC_PAT_CONFIG = getStaticPatConfig();
setConfiguredPatCount(STATIC_PAT_CONFIG?.tokens.length || 0);

function getClusterPatConfig(): ClusterPatConfig | null {
  const entries = parseClusterPatEntries(AUTH_CLUSTER_PAT_TOKENS);
  if (entries.length === 0) {
    return null;
  }

  return { entries };
}

const CLUSTER_PAT_CONFIG = getClusterPatConfig();
setConfiguredClusterPatCount(CLUSTER_PAT_CONFIG?.entries.length || 0);

// F19 / F18: wrap key ring + proof cache. Both are absent (effectively
// disabled) when UPSTREAM_AUTH_WRAP_KEYS is empty or unset; the auth
// service then rejects any aocrwrap:* token with a clear error rather than
// silently falling through to the API validator (which would 401 anyway,
// but with a misleading reason).
const UPSTREAM_AUTH_WRAP_KEY_RING: WrapKeyRing = parseWrapKeyRing(process.env.UPSTREAM_AUTH_WRAP_KEYS);
const UPSTREAM_PROOF_CACHE = new ProofCache();

function buildClusterPatProfile(clusterId: string): ValidationUserProfile {
  const subject = `cluster:${clusterId}`;
  return {
    externalId: subject,
    username: null,
    email: null,
    displayName: subject,
    avatarUrl: null,
    authProvider: CLUSTER_PAT_PROVIDER,
    rawProfile: {
      source: CLUSTER_PAT_PROVIDER,
      user: { id: subject },
      authProvider: CLUSTER_PAT_PROVIDER,
      clusterId,
    },
  };
}

function buildWrappedUpstreamProfile(identity: string): ValidationUserProfile {
  // Short, log-safe identifier — never the full sha256, and never the host
  // or username from the envelope. The full identity stays inside the proof
  // cache only.
  const subject = `wrapped:${identity.slice(0, 16)}`;
  return {
    externalId: subject,
    username: null,
    email: null,
    displayName: subject,
    avatarUrl: null,
    authProvider: WRAPPED_UPSTREAM_PROVIDER,
    rawProfile: {
      source: WRAPPED_UPSTREAM_PROVIDER,
      user: { id: subject },
      authProvider: WRAPPED_UPSTREAM_PROVIDER,
    },
  };
}

async function validateUsingWrappedUpstream(
  presentedToken: string,
  scope: unknown,
): Promise<ValidationResult> {
  const outcome = await validateWrappedUpstream(presentedToken, scope, {
    keyRing: UPSTREAM_AUTH_WRAP_KEY_RING,
    proofCache: UPSTREAM_PROOF_CACHE,
  });
  return {
    strategy: 'wrapped-upstream',
    userProfile: buildWrappedUpstreamProfile(outcome.identity),
    credIdentity: outcome.identity,
  };
}

function validateUsingClusterPat(validationToken: string): ValidationResult | null {
  if (!CLUSTER_PAT_CONFIG) {
    return null;
  }

  for (const entry of CLUSTER_PAT_CONFIG.entries) {
    if (tokensMatch(entry.token, validationToken)) {
      return {
        strategy: 'cluster-pat',
        userProfile: buildClusterPatProfile(entry.clusterId),
        clusterId: entry.clusterId,
      };
    }
  }

  return null;
}

function getValidationInfoUrl(): string {
  if (!VALIDATION_SERVICE_URL) {
    throw new Error('VALIDATION_SERVICE_URL not configured');
  }

  const trimmedUrl = VALIDATION_SERVICE_URL.replace(/\/+$/, '');
  if (trimmedUrl.endsWith('/api/auth/info')) {
    return trimmedUrl;
  }

  return `${trimmedUrl}/api/auth/info`;
}

function extractPresentedCredentials(authHeader?: string): { validationToken: string; presentedIdentity: string | null } {
  if (!authHeader) {
    throw new Error('Auth token required');
  }

  if (authHeader.startsWith('Bearer ')) {
    return {
      validationToken: authHeader.slice('Bearer '.length).trim(),
      presentedIdentity: null,
    };
  }

  if (authHeader.startsWith('Basic ')) {
    const encodedCredentials = authHeader.slice('Basic '.length).trim();
    const decodedCredentials = Buffer.from(encodedCredentials, 'base64').toString('utf8');
    const separatorIndex = decodedCredentials.indexOf(':');

    if (separatorIndex < 0) {
      throw new Error('Invalid basic auth payload');
    }

    const username = decodedCredentials.slice(0, separatorIndex).trim();
    const password = decodedCredentials.slice(separatorIndex + 1).trim();

    if (!password) {
      throw new Error('Registry token required');
    }

    return {
      validationToken: password,
      presentedIdentity: username || null,
    };
  }

  throw new Error('Unsupported authorization scheme');
}

function normalizeValidationProfile(payload: any): ValidationUserProfile {
  const userPayload = payload?.user ?? payload;
  if (!userPayload?.id) {
    throw new Error('Validation service did not return a user id');
  }

  return {
    externalId: String(userPayload.id),
    username: userPayload.username ? String(userPayload.username) : null,
    email: userPayload.email ? String(userPayload.email) : null,
    displayName: userPayload.name ? String(userPayload.name) : (userPayload.username ? String(userPayload.username) : null),
    avatarUrl: userPayload.avatar ? String(userPayload.avatar) : null,
    authProvider: payload?.authProvider ? String(payload.authProvider) : (userPayload.authProvider ? String(userPayload.authProvider) : null),
    rawProfile: payload,
  };
}

function tokensMatch(expectedToken: string, presentedToken: string): boolean {
  const expected = Buffer.from(expectedToken, 'utf8');
  const presented = Buffer.from(presentedToken, 'utf8');

  if (expected.length !== presented.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, presented);
}

function validateUsingStaticPat(validationToken: string): ValidationResult | null {
  if (!STATIC_PAT_CONFIG) {
    return null;
  }

  for (const configuredToken of STATIC_PAT_CONFIG.tokens) {
    if (tokensMatch(configuredToken, validationToken)) {
      return {
        strategy: 'pat',
        userProfile: STATIC_PAT_CONFIG.userProfile,
      };
    }
  }

  return null;
}

async function validateUsingApi(validationToken: string): Promise<ValidationResult> {
  const startedAt = process.hrtime.bigint();

  try {
    const response = await axios.get(getValidationInfoUrl(), {
      headers: { Authorization: `Bearer ${validationToken}` },
      timeout: 10000,
    });

    recordUpstreamValidation('success', elapsedSecondsSince(startedAt));

    return {
      strategy: 'api',
      userProfile: normalizeValidationProfile(response.data),
    };
  } catch (error) {
    recordUpstreamValidation('error', elapsedSecondsSince(startedAt));
    throw error;
  }
}

async function validatePresentedToken(validationToken: string, scope: unknown): Promise<ValidationResult> {
  if (isWrappedUpstreamToken(validationToken)) {
    const startedAt = process.hrtime.bigint();
    try {
      const wrappedResult = await validateUsingWrappedUpstream(validationToken, scope);
      recordTokenValidation('wrapped-upstream', 'success', elapsedSecondsSince(startedAt));
      return wrappedResult;
    } catch (error) {
      recordTokenValidation('wrapped-upstream', 'error', elapsedSecondsSince(startedAt));
      throw error;
    }
  }

  if (STATIC_PAT_CONFIG) {
    const startedAt = process.hrtime.bigint();
    const staticPatResult = validateUsingStaticPat(validationToken);
    if (staticPatResult) {
      recordTokenValidation('pat', 'success', elapsedSecondsSince(startedAt));
      return staticPatResult;
    }

    recordTokenValidation('pat', 'miss', elapsedSecondsSince(startedAt));
  }

  if (CLUSTER_PAT_CONFIG) {
    const startedAt = process.hrtime.bigint();
    const clusterPatResult = validateUsingClusterPat(validationToken);
    if (clusterPatResult) {
      recordTokenValidation('cluster-pat', 'success', elapsedSecondsSince(startedAt));
      return clusterPatResult;
    }

    recordTokenValidation('cluster-pat', 'miss', elapsedSecondsSince(startedAt));
  }

  if (VALIDATION_SERVICE_URL) {
    const startedAt = process.hrtime.bigint();

    try {
      const validationResult = await validateUsingApi(validationToken);
      recordTokenValidation('api', 'success', elapsedSecondsSince(startedAt));
      return validationResult;
    } catch (error) {
      recordTokenValidation('api', 'error', elapsedSecondsSince(startedAt));
      throw error;
    }
  }

  if (STATIC_PAT_CONFIG || CLUSTER_PAT_CONFIG) {
    throw new Error('Invalid PAT token');
  }

  throw new Error('No validation method configured');
}

function presentedIdentityMatchesUser(presentedIdentity: string | null, account: unknown, userProfile: ValidationUserProfile): boolean {
  const identitiesToCheck = [presentedIdentity, typeof account === 'string' ? account : null]
    .filter((identity): identity is string => identity != null && identity.trim() !== '')
    .map((identity) => identity.trim().toLowerCase());

  if (identitiesToCheck.length === 0) {
    return true;
  }

  const validIdentities = [
    userProfile.externalId,
    userProfile.username,
    userProfile.email,
  ]
    .filter((identity): identity is string => identity != null && identity.trim() !== '')
    .map((identity) => identity.trim().toLowerCase());

  return identitiesToCheck.every((identity) => validIdentities.includes(identity));
}

// Docker Token Authentication endpoint
app.get('/v2/token', async (req, res) => {
  const { account, service, scope } = req.query;
  const authHeader = req.headers.authorization;
  let validationStrategy: 'api' | 'pat' | 'cluster-pat' | 'wrapped-upstream' | 'unknown' = 'unknown';

  try {
    const { validationToken, presentedIdentity } = extractPresentedCredentials(authHeader);

    // 1. Validate with the static PAT fast-path first, then fall back to the API validator.
    const validationResult = await validatePresentedToken(validationToken, scope);
    validationStrategy = validationResult.strategy;
    const userProfile = validationResult.userProfile;
    if (validationResult.strategy === 'api' && !presentedIdentityMatchesUser(presentedIdentity, account, userProfile)) {
      return res.status(401).json({ error: 'Presented registry identity does not match validated user' });
    }

    // 2. Sync user and repository metadata in Postgres
    if (validationResult.strategy === 'api') {
      const dbSyncStartedAt = process.hrtime.bigint();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Update/Insert user
        const userRes = await client.query(
          `INSERT INTO users (external_id, username, email, display_name, avatar_url, auth_provider, profile)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
           ON CONFLICT (external_id) DO UPDATE SET
             username = EXCLUDED.username,
             email = EXCLUDED.email,
             display_name = EXCLUDED.display_name,
             avatar_url = EXCLUDED.avatar_url,
             auth_provider = EXCLUDED.auth_provider,
             profile = EXCLUDED.profile
           RETURNING id`,
          [
            userProfile.externalId,
            userProfile.username,
            userProfile.email,
            userProfile.displayName,
            userProfile.avatarUrl,
            userProfile.authProvider,
            JSON.stringify(userProfile.rawProfile),
          ]
        );
        const userId = userRes.rows[0].id;

        // Handle scope (repository and permissions)
        // scope=repository:org/repo:pull,push
        if (scope) {
          const [type, name] = (scope as string).split(':');
          if (type === 'repository') {
            const [org, repo] = name.split('/');
            if (org && repo) {
              await client.query(
                `INSERT INTO repositories (organization, name, user_id)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (organization, name) DO UPDATE SET user_id = EXCLUDED.user_id`,
                [org, repo, userId]
              );
            }
          }
        }

        await client.query('COMMIT');
        recordDatabaseSync('success', elapsedSecondsSince(dbSyncStartedAt));
      } catch (err) {
        await client.query('ROLLBACK');
        recordDatabaseSync('error', elapsedSecondsSince(dbSyncStartedAt));
        console.error('Database sync error:', err);
      } finally {
        client.release();
      }
    }

    // 3. Issue Docker-compatible JWT
    const access = [];
    if (scope) {
      const [type, name, actionsStr] = (scope as string).split(':');
      const requestedActions = (actionsStr || '').split(',').filter((action) => action.length > 0);
      let permittedActions = requestedActions;

      if (validationResult.strategy === 'cluster-pat') {
        if (!validationResult.clusterId) {
          recordTokenIssuance('cluster-pat', 'error');
          return res.status(401).json({ error: 'cluster PAT missing cluster_id' });
        }

        const decision = evaluateClusterPatScope(validationResult.clusterId, type, name, requestedActions);
        if (!decision.allowed) {
          recordTokenIssuance('cluster-pat', 'forbidden');
          return res.status(401).json({ error: decision.reason || 'cluster PAT scope rejected' });
        }
        permittedActions = decision.allowedActions;
      }

      access.push({
        type,
        name,
        actions: permittedActions,
      });
    }

    const ttlSeconds = validationResult.strategy === 'wrapped-upstream'
      ? WRAPPED_UPSTREAM_TOKEN_TTL_SECONDS
      : 3600;
    const payload = {
      iss: ISSUER,
      sub: userProfile.externalId,
      aud: typeof service === 'string' && service ? service : DEFAULT_REGISTRY_SERVICE,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
      access,
      context: {
        external_id: userProfile.externalId,
        username: userProfile.username,
        email: userProfile.email,
        display_name: userProfile.displayName,
        avatar_url: userProfile.avatarUrl,
        auth_provider: userProfile.authProvider,
      }
    };

    if (!JWT_PRIVATE_KEY) {
      throw new Error('JWT_PRIVATE_KEY not configured');
    }

    const kid = computeLibtrustKeyId(JWT_PRIVATE_KEY);
    console.log('[token] computed kid:', kid);
  console.log('[token] validated with strategy:', validationResult.strategy);
    console.log('[token] signing for sub:', userProfile.externalId, 'aud:', typeof service === 'string' && service ? service : DEFAULT_REGISTRY_SERVICE);
    const signedToken = jwt.sign(payload, JWT_PRIVATE_KEY, { algorithm: 'RS256', keyid: kid });
    const [headerB64] = signedToken.split('.');
    console.log('[token] JWT header:', Buffer.from(headerB64, 'base64url').toString());

    res.json({
      token: signedToken,
      expires_in: ttlSeconds,
      issued_at: new Date().toISOString()
    });
    recordTokenIssuance(validationStrategy, 'success');

  } catch (err) {
    recordTokenIssuance(validationStrategy, 'error');
    console.error('[token] error:', err);
    res.status(401).json({ error: 'Invalid token' });
  }
});

app.get('/v1/images', async (req, res) => {
  try {
    const { validationToken } = extractPresentedCredentials(req.headers.authorization);
    const result = await validatePresentedToken(validationToken, null);

    if (result.strategy === 'cluster-pat' || result.strategy === 'wrapped-upstream') {
      return res.status(403).json({ error: 'unsupported_scope' });
    }

    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);

    const scope: 'admin' | 'user' = result.strategy === 'pat' ? 'admin' : 'user';

    let page;
    try {
      page = scope === 'admin'
        ? await listAllImages(pool, limit, offset)
        : await listImagesForExternalId(pool, result.userProfile.externalId, limit, offset);
    } catch (dbErr) {
      console.error('[images] db error:', dbErr);
      return res.status(500).json({ error: 'db_error' });
    }

    res.json({
      scope,
      user: scope === 'admin' ? null : {
        external_id: result.userProfile.externalId,
        username: result.userProfile.username,
        email: result.userProfile.email,
      },
      limit,
      offset,
      count: page.rows.length,
      has_more: page.hasMore,
      next_offset: page.hasMore ? offset + page.rows.length : null,
      images: page.rows,
    });
  } catch (err) {
    console.error('[images] auth error:', err);
    res.status(401).json({ error: 'invalid_token' });
  }
});

app.listen(port, () => {
  console.log(`Auth service listening at http://localhost:${port}`);
  if (JWT_PRIVATE_KEY) {
    try {
      const kid = computeLibtrustKeyId(JWT_PRIVATE_KEY);
      console.log('[startup] libtrust kid from private key:', kid);
    } catch (e) {
      console.error('[startup] failed to compute kid from private key:', e);
    }
  } else {
    console.error('[startup] JWT_PRIVATE_KEY is not set');
  }
});
