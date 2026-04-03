import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';

const app = express();
const port = process.env.PORT || 8080;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const VALIDATION_SERVICE_URL = process.env.VALIDATION_SERVICE_URL;
const JWT_PRIVATE_KEY = process.env.JWT_PRIVATE_KEY?.replace(/\\n/g, '\n');
const ISSUER = 'ttl-auth';
const SERVICE = 'ttl.sh';

app.use(express.json());

// Docker Token Authentication endpoint
app.get('/v2/token', async (req, res) => {
  const { account, service, scope } = req.query;
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Auth token required' });
  }

  const token = authHeader.split(' ')[1];

  try {
    // 1. Validate token with third-party service
    const response = await axios.get(`${VALIDATION_SERVICE_URL}/validate`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const userData = response.data; // { id: '...', name: '...', ... }
    const externalId = userData.id;

    // 2. Sync user and repository metadata in Postgres
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Update/Insert user
      const userRes = await client.query(
        'INSERT INTO users (external_id, display_name) VALUES ($1, $2) ON CONFLICT (external_id) DO UPDATE SET display_name = $2 RETURNING id',
        [externalId, userData.name]
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
              'INSERT INTO repositories (organization, name, user_id) VALUES ($1, $2, $3) ON CONFLICT (organization, name) DO NOTHING',
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
      sub: account || userData.name,
      aud: SERVICE,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour
      access
    };

    if (!JWT_PRIVATE_KEY) {
      throw new Error('JWT_PRIVATE_KEY not configured');
    }

    const signedToken = jwt.sign(payload, JWT_PRIVATE_KEY, { algorithm: 'RS256' });

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
