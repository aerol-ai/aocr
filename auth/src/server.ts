import { Pool } from 'pg';
import { bindMetricsPool } from './metrics';
import { configFromEnv, createApp } from './createApp';
import { computeLibtrustKeyId, getDatabaseConnectionString } from './serverHelpers';

const pool = new Pool({
  connectionString: getDatabaseConnectionString(),
});
bindMetricsPool(pool);

const { app } = createApp({
  pool,
  config: configFromEnv(),
});

const port = process.env.PORT || 8080;
const jwtPrivateKey = process.env.JWT_PRIVATE_KEY?.replace(/\\n/g, '\n');

app.listen(port, () => {
  console.log(`Auth service listening at http://localhost:${port}`);
  if (jwtPrivateKey) {
    try {
      const kid = computeLibtrustKeyId(jwtPrivateKey);
      console.log('[startup] libtrust kid from private key:', kid);
    } catch (e) {
      console.error('[startup] failed to compute kid from private key:', e);
    }
  } else {
    console.error('[startup] JWT_PRIVATE_KEY is not set');
  }
});
