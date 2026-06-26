import axios from 'axios';
import crypto from 'crypto';
import {
  ClusterPatEntry,
  parseClusterPatEntries,
} from './clusterPat';
import { ProofCache } from './upstreamAuth/proofCache';
import {
  isWrappedUpstreamToken,
  validateWrappedUpstream,
} from './upstreamAuth/strategy';
import type { WrapKeyRing } from './upstreamAuth/wrap';
import {
  elapsedSecondsSince,
  recordTokenValidation,
  recordUpstreamValidation,
} from './metrics';

export function computeLibtrustKeyId(privateKeyPem: string): string {
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

export function getDatabaseConnectionString(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DATABASE_URL) {
    return env.DATABASE_URL;
  }

  const host = env.POSTGRES_HOST;
  const database = env.POSTGRES_DB;
  const user = env.POSTGRES_USER;
  const password = env.POSTGRES_PASSWORD;
  const dbPort = env.POSTGRES_PORT || '5432';

  if (!host || !database || !user || !password) {
    throw new Error('DATABASE_URL or POSTGRES_HOST/POSTGRES_DB/POSTGRES_USER/POSTGRES_PASSWORD must be configured');
  }

  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${dbPort}/${database}`;
}

export interface ValidationUserProfile {
  externalId: string;
  username: string | null;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  authProvider: string | null;
  rawProfile: Record<string, unknown>;
}

export interface StaticPatConfig {
  tokens: string[];
  userProfile: ValidationUserProfile;
}

export interface ClusterPatConfig {
  entries: ClusterPatEntry[];
}

export interface ValidationResult {
  strategy: 'api' | 'pat' | 'cluster-pat' | 'wrapped-upstream';
  userProfile: ValidationUserProfile;
  clusterId?: string;
  credIdentity?: string;
}

export interface AuthValidationContext {
  staticPatConfig: StaticPatConfig | null;
  clusterPatConfig: ClusterPatConfig | null;
  validationServiceUrl?: string;
  keyRing: WrapKeyRing;
  proofCache: ProofCache;
}

export const STATIC_PAT_SUBJECT = 'static-pat';
export const STATIC_PAT_PROVIDER = 'static-pat';
export const CLUSTER_PAT_PROVIDER = 'cluster-pat';
export const WRAPPED_UPSTREAM_PROVIDER = 'wrapped-upstream';

export function parseStaticPatTokens(...rawValues: Array<string | undefined>): string[] {
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

export function buildStaticPatConfig(
  authPatToken?: string,
  authPatTokens?: string,
): StaticPatConfig | null {
  const tokens = parseStaticPatTokens(authPatToken, authPatTokens);
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

export function buildClusterPatConfig(authClusterPatTokens?: string): ClusterPatConfig | null {
  const entries = parseClusterPatEntries(authClusterPatTokens);
  if (entries.length === 0) {
    return null;
  }

  return { entries };
}

export function buildClusterPatProfile(clusterId: string): ValidationUserProfile {
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

export function buildWrappedUpstreamProfile(identity: string): ValidationUserProfile {
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

export function getValidationInfoUrl(validationServiceUrl?: string): string {
  if (!validationServiceUrl) {
    throw new Error('VALIDATION_SERVICE_URL not configured');
  }

  const trimmedUrl = validationServiceUrl.replace(/\/+$/, '');
  if (trimmedUrl.endsWith('/api/auth/info')) {
    return trimmedUrl;
  }

  return `${trimmedUrl}/api/auth/info`;
}

export function extractPresentedCredentials(authHeader?: string): { validationToken: string; presentedIdentity: string | null } {
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

export function normalizeValidationProfile(payload: any): ValidationUserProfile {
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

export function tokensMatch(expectedToken: string, presentedToken: string): boolean {
  const expected = Buffer.from(expectedToken, 'utf8');
  const presented = Buffer.from(presentedToken, 'utf8');

  if (expected.length !== presented.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, presented);
}

export function validateUsingStaticPat(
  validationToken: string,
  staticPatConfig: StaticPatConfig | null,
): ValidationResult | null {
  if (!staticPatConfig) {
    return null;
  }

  for (const configuredToken of staticPatConfig.tokens) {
    if (tokensMatch(configuredToken, validationToken)) {
      return {
        strategy: 'pat',
        userProfile: staticPatConfig.userProfile,
      };
    }
  }

  return null;
}

export function validateUsingClusterPat(
  validationToken: string,
  clusterPatConfig: ClusterPatConfig | null,
): ValidationResult | null {
  if (!clusterPatConfig) {
    return null;
  }

  for (const entry of clusterPatConfig.entries) {
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

async function validateUsingWrappedUpstream(
  presentedToken: string,
  scope: unknown,
  ctx: AuthValidationContext,
): Promise<ValidationResult> {
  const outcome = await validateWrappedUpstream(presentedToken, scope, {
    keyRing: ctx.keyRing,
    proofCache: ctx.proofCache,
  });
  return {
    strategy: 'wrapped-upstream',
    userProfile: buildWrappedUpstreamProfile(outcome.identity),
    credIdentity: outcome.identity,
  };
}

async function validateUsingApi(
  validationToken: string,
  validationServiceUrl?: string,
): Promise<ValidationResult> {
  const startedAt = process.hrtime.bigint();

  try {
    const response = await axios.get(getValidationInfoUrl(validationServiceUrl), {
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

export async function validatePresentedToken(
  validationToken: string,
  scope: unknown,
  ctx: AuthValidationContext,
): Promise<ValidationResult> {
  if (isWrappedUpstreamToken(validationToken)) {
    const startedAt = process.hrtime.bigint();
    try {
      const wrappedResult = await validateUsingWrappedUpstream(validationToken, scope, ctx);
      recordTokenValidation('wrapped-upstream', 'success', elapsedSecondsSince(startedAt));
      return wrappedResult;
    } catch (error) {
      recordTokenValidation('wrapped-upstream', 'error', elapsedSecondsSince(startedAt));
      throw error;
    }
  }

  if (ctx.staticPatConfig) {
    const startedAt = process.hrtime.bigint();
    const staticPatResult = validateUsingStaticPat(validationToken, ctx.staticPatConfig);
    if (staticPatResult) {
      recordTokenValidation('pat', 'success', elapsedSecondsSince(startedAt));
      return staticPatResult;
    }

    recordTokenValidation('pat', 'miss', elapsedSecondsSince(startedAt));
  }

  if (ctx.clusterPatConfig) {
    const startedAt = process.hrtime.bigint();
    const clusterPatResult = validateUsingClusterPat(validationToken, ctx.clusterPatConfig);
    if (clusterPatResult) {
      recordTokenValidation('cluster-pat', 'success', elapsedSecondsSince(startedAt));
      return clusterPatResult;
    }

    recordTokenValidation('cluster-pat', 'miss', elapsedSecondsSince(startedAt));
  }

  if (ctx.validationServiceUrl) {
    const startedAt = process.hrtime.bigint();

    try {
      const validationResult = await validateUsingApi(validationToken, ctx.validationServiceUrl);
      recordTokenValidation('api', 'success', elapsedSecondsSince(startedAt));
      return validationResult;
    } catch (error) {
      recordTokenValidation('api', 'error', elapsedSecondsSince(startedAt));
      throw error;
    }
  }

  if (ctx.staticPatConfig || ctx.clusterPatConfig) {
    throw new Error('Invalid PAT token');
  }

  throw new Error('No validation method configured');
}

export function presentedIdentityMatchesUser(
  presentedIdentity: string | null,
  account: unknown,
  userProfile: ValidationUserProfile,
): boolean {
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
