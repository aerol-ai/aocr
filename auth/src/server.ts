import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import crypto from 'crypto';

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

const VALIDATION_SERVICE_URL = process.env.VALIDATION_SERVICE_URL;
const JWT_PRIVATE_KEY = process.env.JWT_PRIVATE_KEY?.replace(/\\n/g, '\n');
const ISSUER = 'aocr-auth';
const DEFAULT_REGISTRY_SERVICE = process.env.REGISTRY_SERVICE || 'aocr';

app.use(express.json());

interface ValidationUserProfile {
  externalId: string;
  username: string | null;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  authProvider: string | null;
  rawProfile: Record<string, unknown>;
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

  try {
    const { validationToken, presentedIdentity } = extractPresentedCredentials(authHeader);

    // 1. Validate token with the upstream auth-info endpoint
    const response = await axios.get(getValidationInfoUrl(), {
      headers: { Authorization: `Bearer ${validationToken}` },
      timeout: 10000,
    });

    const userProfile = normalizeValidationProfile(response.data);
    if (!presentedIdentityMatchesUser(presentedIdentity, account, userProfile)) {
      return res.status(401).json({ error: 'Presented registry identity does not match validated user' });
    }

    // 2. Sync user and repository metadata in Postgres
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
        const [type, name, actions] = (scope as string).split(':');
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
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Database sync error:', err);
    } finally {
      client.release();
    }

    // 3. Issue Docker-compatible JWT
    const access = [];
    if (scope) {
      const [type, name, actions] = (scope as string).split(':');
      access.push({
        type,
        name,
        actions: actions.split(',')
      });
    }

    const payload = {
      iss: ISSUER,
      sub: userProfile.externalId,
      aud: typeof service === 'string' && service ? service : DEFAULT_REGISTRY_SERVICE,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour
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
    const signedToken = jwt.sign(payload, JWT_PRIVATE_KEY, { algorithm: 'RS256', keyid: kid });

    res.json({
      token: signedToken,
      expires_in: 3600,
      issued_at: new Date().toISOString()
    });

  } catch (err) {
    console.error('Validation error:', err);
    res.status(401).json({ error: 'Invalid token' });
  }
});

app.listen(port, () => {
  console.log(`Auth service listening at http://localhost:${port}`);
});
