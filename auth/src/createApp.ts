import express, { Express } from 'express';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { evaluateClusterPatScope } from './clusterPat';
import {
  elapsedSecondsSince,
  mountMetrics,
  recordDatabaseSync,
  recordTokenIssuance,
  setConfiguredClusterPatCount,
  setConfiguredPatCount,
} from './metrics';
import {
  listAllImages,
  listImagesForExternalId,
  parseLimit,
  parseOffset,
} from './imageList';
import { ProofCache } from './upstreamAuth/proofCache';
import {
  WRAPPED_UPSTREAM_TOKEN_TTL_SECONDS,
} from './upstreamAuth/strategy';
import { parseWrapKeyRing } from './upstreamAuth/wrap';
import {
  AuthValidationContext,
  buildClusterPatConfig,
  buildStaticPatConfig,
  computeLibtrustKeyId,
  extractPresentedCredentials,
  presentedIdentityMatchesUser,
  validatePresentedToken,
  ValidationResult,
} from './serverHelpers';

export interface AuthServiceConfig {
  validationServiceUrl?: string;
  authPatToken?: string;
  authPatTokens?: string;
  authClusterPatTokens?: string;
  jwtPrivateKey?: string;
  issuer?: string;
  defaultRegistryService?: string;
  upstreamAuthWrapKeys?: string;
}

export interface CreateAppOptions {
  pool: Pool;
  config: AuthServiceConfig;
}

export interface AuthApp {
  app: Express;
  validationContext: AuthValidationContext;
}

function buildValidationContext(config: AuthServiceConfig): AuthValidationContext {
  const staticPatConfig = buildStaticPatConfig(config.authPatToken, config.authPatTokens);
  const clusterPatConfig = buildClusterPatConfig(config.authClusterPatTokens);
  setConfiguredPatCount(staticPatConfig?.tokens.length || 0);
  setConfiguredClusterPatCount(clusterPatConfig?.entries.length || 0);

  return {
    staticPatConfig,
    clusterPatConfig,
    validationServiceUrl: config.validationServiceUrl,
    keyRing: parseWrapKeyRing(config.upstreamAuthWrapKeys),
    proofCache: new ProofCache(),
  };
}

export function createApp(options: CreateAppOptions): AuthApp {
  const { pool, config } = options;
  const validationContext = buildValidationContext(config);
  const jwtPrivateKey = config.jwtPrivateKey?.replace(/\\n/g, '\n');
  const issuer = config.issuer || 'aocr-auth';
  const defaultRegistryService = config.defaultRegistryService || 'aocr';

  const app = express();
  app.use(express.json());
  mountMetrics(app);

  app.get('/v2/token', async (req, res) => {
    const { account, service, scope } = req.query;
    const authHeader = req.headers.authorization;
    let validationStrategy: ValidationResult['strategy'] | 'unknown' = 'unknown';

    try {
      const { validationToken, presentedIdentity } = extractPresentedCredentials(authHeader);

      const validationResult = await validatePresentedToken(validationToken, scope, validationContext);
      validationStrategy = validationResult.strategy;
      const userProfile = validationResult.userProfile;
      if (validationResult.strategy === 'api' && !presentedIdentityMatchesUser(presentedIdentity, account, userProfile)) {
        return res.status(401).json({ error: 'Presented registry identity does not match validated user' });
      }

      if (validationResult.strategy === 'api') {
        const dbSyncStartedAt = process.hrtime.bigint();
        const client = await pool.connect();
        try {
          await client.query('BEGIN');

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
            ],
          );
          const userId = userRes.rows[0].id;

          if (scope) {
            const [type, name] = (scope as string).split(':');
            if (type === 'repository') {
              const [org, repo] = name.split('/');
              if (org && repo) {
                await client.query(
                  `INSERT INTO repositories (organization, name, user_id)
                   VALUES ($1, $2, $3)
                   ON CONFLICT (organization, name) DO UPDATE SET user_id = EXCLUDED.user_id`,
                  [org, repo, userId],
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
        iss: issuer,
        sub: userProfile.externalId,
        aud: typeof service === 'string' && service ? service : defaultRegistryService,
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
        },
      };

      if (!jwtPrivateKey) {
        throw new Error('JWT_PRIVATE_KEY not configured');
      }

      const kid = computeLibtrustKeyId(jwtPrivateKey);
      const signedToken = jwt.sign(payload, jwtPrivateKey, { algorithm: 'RS256', keyid: kid });

      res.json({
        token: signedToken,
        expires_in: ttlSeconds,
        issued_at: new Date().toISOString(),
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
      const result = await validatePresentedToken(validationToken, null, validationContext);

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

  return { app, validationContext };
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AuthServiceConfig {
  return {
    validationServiceUrl: env.VALIDATION_SERVICE_URL,
    authPatToken: env.AUTH_PAT_TOKEN,
    authPatTokens: env.AUTH_PAT_TOKENS,
    authClusterPatTokens: env.AUTH_CLUSTER_PAT_TOKENS,
    jwtPrivateKey: env.JWT_PRIVATE_KEY,
    issuer: env.AUTH_ISSUER,
    defaultRegistryService: env.REGISTRY_SERVICE,
    upstreamAuthWrapKeys: env.UPSTREAM_AUTH_WRAP_KEYS,
  };
}
