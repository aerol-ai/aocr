import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { routeMatchesWrappedHost, routeMirrorRepoToUpstream } from '../upstreamAuth/route';

describe('routeMirrorRepoToUpstream', () => {
  it('routes the docker.io library shortcut', () => {
    assert.deepEqual(routeMirrorRepoToUpstream('library/redis'), {
      host: 'docker.io',
      upstreamRepo: 'library/redis',
    });
  });

  it('routes a docker.io user/repo namespace', () => {
    assert.deepEqual(routeMirrorRepoToUpstream('grafana/grafana'), {
      host: 'docker.io',
      upstreamRepo: 'grafana/grafana',
    });
  });

  it('strips the _/ghcr/ prefix and routes to ghcr.io', () => {
    assert.deepEqual(routeMirrorRepoToUpstream('_/ghcr/aerol-ai/sandbox'), {
      host: 'ghcr.io',
      upstreamRepo: 'aerol-ai/sandbox',
    });
  });

  it('strips the _/gcr/ prefix and routes to gcr.io', () => {
    assert.deepEqual(routeMirrorRepoToUpstream('_/gcr/distroless/base'), {
      host: 'gcr.io',
      upstreamRepo: 'distroless/base',
    });
  });

  it('strips the _/quay/ prefix and routes to quay.io', () => {
    assert.deepEqual(routeMirrorRepoToUpstream('_/quay/prometheus/node-exporter'), {
      host: 'quay.io',
      upstreamRepo: 'prometheus/node-exporter',
    });
  });

  it('strips the _/k8s/ prefix and routes to registry.k8s.io', () => {
    assert.deepEqual(routeMirrorRepoToUpstream('_/k8s/pause'), {
      host: 'registry.k8s.io',
      upstreamRepo: 'pause',
    });
  });

  it('handles deeper paths under known prefixes', () => {
    assert.deepEqual(routeMirrorRepoToUpstream('_/gcr/google-containers/pause-amd64'), {
      host: 'gcr.io',
      upstreamRepo: 'google-containers/pause-amd64',
    });
  });

  it('rejects unknown reserved prefixes', () => {
    assert.equal(routeMirrorRepoToUpstream('_/unknown/something'), null);
    // `_/ghcr/` with nothing after it — no upstream repo.
    assert.equal(routeMirrorRepoToUpstream('_/ghcr/'), null);
  });

  it('rejects empty input', () => {
    assert.equal(routeMirrorRepoToUpstream(''), null);
  });
});

describe('routeMatchesWrappedHost', () => {
  it('matches case-insensitively', () => {
    const route = { host: 'ghcr.io', upstreamRepo: 'org/repo' };
    assert.equal(routeMatchesWrappedHost(route, 'GHCR.IO'), true);
    assert.equal(routeMatchesWrappedHost(route, 'ghcr.io'), true);
  });

  it('returns false on mismatch', () => {
    const route = { host: 'ghcr.io', upstreamRepo: 'org/repo' };
    assert.equal(routeMatchesWrappedHost(route, 'docker.io'), false);
  });
});
