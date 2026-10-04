import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parseRequestedScopes, parseScope } from '../scope';

describe('parseScope', () => {
  it('splits type, name and actions', () => {
    assert.deepEqual(parseScope('repository:acme/app:pull,push'), {
      type: 'repository',
      name: 'acme/app',
      actions: ['pull', 'push'],
    });
  });

  it('keeps a colon inside the name (registry host:port)', () => {
    assert.deepEqual(parseScope('repository:localhost:5000/acme/app:pull'), {
      type: 'repository',
      name: 'localhost:5000/acme/app',
      actions: ['pull'],
    });
  });

  it('allows an empty action list', () => {
    assert.deepEqual(parseScope('repository:acme/app:'), {
      type: 'repository',
      name: 'acme/app',
      actions: [],
    });
  });

  it('returns null for malformed entries', () => {
    for (const value of ['', 'no-colon', 'repository:acme', ':acme/app:pull', 'repository::pull']) {
      assert.equal(parseScope(value), null, value);
    }
  });
});

describe('parseRequestedScopes', () => {
  it('returns no scopes for absent or non-string input', () => {
    assert.deepEqual(parseRequestedScopes(undefined), []);
    assert.deepEqual(parseRequestedScopes(''), []);
    assert.deepEqual(parseRequestedScopes(42), []);
    assert.deepEqual(parseRequestedScopes({ x: 'repository:acme/app:pull' }), []);
  });

  it('parses a single string scope', () => {
    assert.deepEqual(parseRequestedScopes('repository:acme/app:pull'), [
      { type: 'repository', name: 'acme/app', actions: ['pull'] },
    ]);
  });

  it('merges repeated scopes for the same resource (containerd push shape)', () => {
    assert.deepEqual(
      parseRequestedScopes(['repository:acme/app:pull', 'repository:acme/app:pull,push']),
      [{ type: 'repository', name: 'acme/app', actions: ['pull', 'push'] }],
    );
  });

  it('keeps distinct resources apart, in first-seen order', () => {
    assert.deepEqual(
      parseRequestedScopes(['repository:acme/b:pull', 'repository:acme/a:pull,push', 'registry:catalog:*']),
      [
        { type: 'repository', name: 'acme/b', actions: ['pull'] },
        { type: 'repository', name: 'acme/a', actions: ['pull', 'push'] },
        { type: 'registry', name: 'catalog', actions: ['*'] },
      ],
    );
  });

  it('de-duplicates actions within one entry', () => {
    assert.deepEqual(parseRequestedScopes('repository:acme/app:pull,pull,,push'), [
      { type: 'repository', name: 'acme/app', actions: ['pull', 'push'] },
    ]);
  });

  it('splits space-separated scopes inside one value', () => {
    assert.deepEqual(parseRequestedScopes('repository:acme/a:pull repository:acme/b:push'), [
      { type: 'repository', name: 'acme/a', actions: ['pull'] },
      { type: 'repository', name: 'acme/b', actions: ['push'] },
    ]);
  });

  it('ignores non-string and malformed entries in an array', () => {
    assert.deepEqual(
      parseRequestedScopes([
        'garbage',
        { x: 'repository:acme/secret:push' },
        ['repository:acme/nested:push'],
        null,
        7,
        'repository:acme/app:pull',
      ]),
      [{ type: 'repository', name: 'acme/app', actions: ['pull'] }],
    );
  });
});
