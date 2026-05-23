import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  buildAdminListQuery,
  buildUserListQuery,
  clampLimit,
  clampOffset,
  listAllImages,
  listImagesForExternalId,
  parseLimit,
  parseOffset,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../imageList';

type QueryCall = { text: string; values: unknown[] };

function fakePool(rowCount: number) {
  const calls: QueryCall[] = [];
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    repository: `org/repo-${i}`,
    tag: `v${i}`,
    manifest_digest: `sha256:${i}`,
    provenance: 'pushed',
    upstream_ref: null,
    cluster_id: null,
    source_sandbox_id: null,
    retention_mode: 'keep-latest',
    retention_value_seconds: null,
    raw_retention_suffix: null,
    last_pushed_at: null,
    last_pulled_at: null,
    expires_at: null,
  }));
  return {
    calls,
    pool: {
      query: async (text: string, values: unknown[]) => {
        calls.push({ text, values });
        return { rows };
      },
    } as any,
  };
}

describe('buildAdminListQuery', () => {
  it('does not include a user filter', () => {
    const { text } = buildAdminListQuery(50, 0);
    assert.ok(!text.includes('users'));
    assert.ok(!text.includes('external_id'));
  });

  it('binds limit and offset as $1 and $2', () => {
    const { text, values } = buildAdminListQuery(25, 10);
    assert.ok(text.includes('LIMIT $1'));
    assert.ok(text.includes('OFFSET $2'));
    assert.deepEqual(values, [25, 10]);
  });

  it('orders by last_pushed_at DESC NULLS LAST', () => {
    const { text } = buildAdminListQuery(10, 0);
    assert.ok(text.includes('ORDER BY i.last_pushed_at DESC NULLS LAST'));
  });
});

describe('buildUserListQuery', () => {
  it('joins users and filters by external_id', () => {
    const { text } = buildUserListQuery('ext-123', 50, 0);
    assert.ok(text.includes('JOIN users u ON u.id = r.user_id'));
    assert.ok(text.includes('WHERE u.external_id = $1'));
  });

  it('binds external_id as $1, limit as $2, offset as $3', () => {
    const { text, values } = buildUserListQuery('ext-abc', 25, 100);
    assert.ok(text.includes('LIMIT $2'));
    assert.ok(text.includes('OFFSET $3'));
    assert.deepEqual(values, ['ext-abc', 25, 100]);
  });

  it('uses the same expires_at projection as admin variant', () => {
    const admin = buildAdminListQuery(1, 0).text;
    const user = buildUserListQuery('x', 1, 0).text;
    assert.ok(admin.includes("CASE i.retention_mode"));
    assert.ok(user.includes("CASE i.retention_mode"));
    assert.ok(admin.includes("WHEN 'ttl'  THEN i.expires_at"));
    assert.ok(user.includes("WHEN 'ttl'  THEN i.expires_at"));
  });
});

describe('clampLimit', () => {
  it('caps at MAX_LIMIT', () => {
    assert.equal(clampLimit(10_000), MAX_LIMIT);
  });

  it('floors at 1', () => {
    assert.equal(clampLimit(0), 1);
    assert.equal(clampLimit(-5), 1);
  });

  it('passes through valid values', () => {
    assert.equal(clampLimit(100), 100);
  });

  it('returns DEFAULT_LIMIT for non-finite input', () => {
    assert.equal(clampLimit(NaN), DEFAULT_LIMIT);
    assert.equal(clampLimit(Infinity), DEFAULT_LIMIT);
  });
});

describe('clampOffset', () => {
  it('floors at 0', () => {
    assert.equal(clampOffset(-1), 0);
  });

  it('returns 0 for NaN', () => {
    assert.equal(clampOffset(NaN), 0);
  });

  it('passes through positive integers', () => {
    assert.equal(clampOffset(42), 42);
  });
});

describe('parseLimit / parseOffset', () => {
  it('parseLimit returns DEFAULT_LIMIT for missing / garbage input', () => {
    assert.equal(parseLimit(undefined), DEFAULT_LIMIT);
    assert.equal(parseLimit(''), DEFAULT_LIMIT);
    assert.equal(parseLimit('abc'), DEFAULT_LIMIT);
    assert.equal(parseLimit('0'), DEFAULT_LIMIT);
    assert.equal(parseLimit('-3'), DEFAULT_LIMIT);
  });

  it('parseLimit caps at MAX_LIMIT', () => {
    assert.equal(parseLimit('5000'), MAX_LIMIT);
  });

  it('parseLimit accepts a valid value', () => {
    assert.equal(parseLimit('250'), 250);
  });

  it('parseOffset returns 0 for missing / garbage input', () => {
    assert.equal(parseOffset(undefined), 0);
    assert.equal(parseOffset(''), 0);
    assert.equal(parseOffset('abc'), 0);
    assert.equal(parseOffset('-1'), 0);
  });

  it('parseOffset accepts a valid value', () => {
    assert.equal(parseOffset('42'), 42);
  });
});

describe('listAllImages has_more', () => {
  it('queries LIMIT limit+1 and reports hasMore=false when the DB returns fewer than limit+1 rows', async () => {
    const { pool, calls } = fakePool(50);
    const page = await listAllImages(pool, 100, 0);
    assert.equal(page.hasMore, false);
    assert.equal(page.rows.length, 50);
    assert.deepEqual(calls[0].values, [101, 0]);
  });

  it('drops the overflow row and reports hasMore=true when the DB returns limit+1 rows', async () => {
    const { pool, calls } = fakePool(101);
    const page = await listAllImages(pool, 100, 0);
    assert.equal(page.hasMore, true);
    assert.equal(page.rows.length, 100);
    assert.deepEqual(calls[0].values, [101, 0]);
  });

  it('reports hasMore=false when the DB returns exactly limit rows (boundary)', async () => {
    const { pool } = fakePool(100);
    const page = await listAllImages(pool, 100, 0);
    assert.equal(page.hasMore, false);
    assert.equal(page.rows.length, 100);
  });
});

describe('listImagesForExternalId has_more', () => {
  it('binds external_id as $1 and limit+1 as $2', async () => {
    const { pool, calls } = fakePool(5);
    await listImagesForExternalId(pool, 'ext-42', 10, 0);
    assert.deepEqual(calls[0].values, ['ext-42', 11, 0]);
  });

  it('drops the overflow row and reports hasMore=true', async () => {
    const { pool } = fakePool(11);
    const page = await listImagesForExternalId(pool, 'ext-42', 10, 0);
    assert.equal(page.hasMore, true);
    assert.equal(page.rows.length, 10);
  });
});
