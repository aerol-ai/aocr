package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Upstream represents a single anonymous-pull public registry the proxy can
// front. Implementations stay small: they only need to spell their canonical
// hostname, hand the proxy a bearer token when the upstream demands one, and
// translate between the client-facing repository segments and how the upstream
// keys content.
type Upstream interface {
	Slug() string
	Host() string

	// NormalizeRepository takes the per-upstream repository segments parsed
	// from the request path (after stripping `/v2/` and any `aocr/<slug>/` prefix)
	// and returns:
	//   - upstreamRepo : the repository identifier to use in the upstream URL
	//     (e.g. "library/redis" for DockerHub, "aerol-ai/foo" for ghcr).
	//   - storagePath  : the path under "mirror/" that the writer sidecar
	//     persists the content at (e.g. "docker/library/redis"). Phase 0's
	//     inferredProvenance() automatically tags rows under "mirror/" as
	//     provenance='mirror' with upstream_ref = storagePath.
	NormalizeRepository(segments []string) (upstreamRepo, storagePath string, err error)

	// AcquireToken returns a bearer token for the given upstream repository,
	// or "" when the upstream does not require one for anonymous pulls.
	AcquireToken(ctx context.Context, httpClient *http.Client, upstreamRepo string) (string, error)
}

// ---- DockerHub ------------------------------------------------------------

type DockerHub struct{}

func (d *DockerHub) Slug() string { return "docker" }
func (d *DockerHub) Host() string { return "registry-1.docker.io" }

func (d *DockerHub) NormalizeRepository(segments []string) (string, string, error) {
	if len(segments) == 0 {
		return "", "", errors.New("mirror: empty repository")
	}
	// DockerHub treats single-segment names as `library/<name>` (the
	// `docker pull redis` UX). Preserve that convention.
	if len(segments) == 1 {
		return "library/" + segments[0], "docker/library/" + segments[0], nil
	}
	repo := strings.Join(segments, "/")
	return repo, "docker/" + repo, nil
}

func (d *DockerHub) AcquireToken(ctx context.Context, c *http.Client, repo string) (string, error) {
	tokenURL := fmt.Sprintf(
		"https://auth.docker.io/token?service=registry.docker.io&scope=repository:%s:pull",
		url.QueryEscape(repo),
	)
	return fetchAnonymousBearer(ctx, c, tokenURL)
}

// ---- GHCR ----------------------------------------------------------------

type GHCR struct{}

func (g *GHCR) Slug() string { return "ghcr" }
func (g *GHCR) Host() string { return "ghcr.io" }

func (g *GHCR) NormalizeRepository(segments []string) (string, string, error) {
	if len(segments) < 2 {
		return "", "", errors.New("mirror: ghcr requires <org>/<name>")
	}
	repo := strings.Join(segments, "/")
	return repo, "ghcr/" + repo, nil
}

func (g *GHCR) AcquireToken(ctx context.Context, c *http.Client, repo string) (string, error) {
	tokenURL := fmt.Sprintf(
		"https://ghcr.io/token?service=ghcr.io&scope=repository:%s:pull",
		url.QueryEscape(repo),
	)
	return fetchAnonymousBearer(ctx, c, tokenURL)
}

// ---- gcr.io --------------------------------------------------------------

type GCR struct{}

func (g *GCR) Slug() string { return "gcr" }
func (g *GCR) Host() string { return "gcr.io" }

func (g *GCR) NormalizeRepository(segments []string) (string, string, error) {
	if len(segments) < 2 {
		return "", "", errors.New("mirror: gcr requires <project>/<name>")
	}
	repo := strings.Join(segments, "/")
	return repo, "gcr/" + repo, nil
}

func (g *GCR) AcquireToken(ctx context.Context, c *http.Client, repo string) (string, error) {
	tokenURL := fmt.Sprintf(
		"https://gcr.io/v2/token?service=gcr.io&scope=repository:%s:pull",
		url.QueryEscape(repo),
	)
	return fetchAnonymousBearer(ctx, c, tokenURL)
}

// ---- quay.io -------------------------------------------------------------

type Quay struct{}

func (q *Quay) Slug() string { return "quay" }
func (q *Quay) Host() string { return "quay.io" }

func (q *Quay) NormalizeRepository(segments []string) (string, string, error) {
	if len(segments) < 2 {
		return "", "", errors.New("mirror: quay requires <org>/<name>")
	}
	repo := strings.Join(segments, "/")
	return repo, "quay/" + repo, nil
}

func (q *Quay) AcquireToken(ctx context.Context, c *http.Client, repo string) (string, error) {
	tokenURL := fmt.Sprintf(
		"https://quay.io/v2/auth?service=quay.io&scope=repository:%s:pull",
		url.QueryEscape(repo),
	)
	return fetchAnonymousBearer(ctx, c, tokenURL)
}

// ---- registry.k8s.io -----------------------------------------------------

type K8sRegistry struct{}

func (k *K8sRegistry) Slug() string { return "k8s" }
func (k *K8sRegistry) Host() string { return "registry.k8s.io" }

func (k *K8sRegistry) NormalizeRepository(segments []string) (string, string, error) {
	if len(segments) == 0 {
		return "", "", errors.New("mirror: empty repository")
	}
	repo := strings.Join(segments, "/")
	return repo, "k8s/" + repo, nil
}

func (k *K8sRegistry) AcquireToken(ctx context.Context, c *http.Client, repo string) (string, error) {
	return "", nil
}

// ---- Token cache ---------------------------------------------------------

type tokenCacheEntry struct {
	token   string
	expires time.Time
}

type TokenCache struct {
	mu      sync.Mutex
	ttl     time.Duration
	entries map[string]tokenCacheEntry
}

func NewTokenCache(ttl time.Duration) *TokenCache {
	return &TokenCache{ttl: ttl, entries: make(map[string]tokenCacheEntry)}
}

// Get fetches a token via `fetch` and caches it for the configured TTL. Empty
// tokens (from anonymous-no-auth upstreams like registry.k8s.io) are not
// cached because they are free anyway.
func (tc *TokenCache) Get(ctx context.Context, key string, fetch func() (string, error)) (string, error) {
	tc.mu.Lock()
	if entry, ok := tc.entries[key]; ok && time.Now().Before(entry.expires) {
		tc.mu.Unlock()
		return entry.token, nil
	}
	tc.mu.Unlock()

	token, err := fetch()
	if err != nil {
		return "", err
	}
	if token == "" {
		return "", nil
	}
	tc.mu.Lock()
	tc.entries[key] = tokenCacheEntry{token: token, expires: time.Now().Add(tc.ttl)}
	tc.mu.Unlock()
	return token, nil
}

// fetchAnonymousBearer GETs `tokenURL` and unpacks the JSON envelope produced
// by `https://distribution.github.io/distribution/spec/auth/token/`-style
// upstreams.
func fetchAnonymousBearer(ctx context.Context, client *http.Client, tokenURL string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, tokenURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("mirror: token request to %s returned %d: %s", tokenURL, resp.StatusCode, string(body))
	}
	var envelope struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return "", fmt.Errorf("mirror: parsing token envelope: %w", err)
	}
	if envelope.Token != "" {
		return envelope.Token, nil
	}
	return envelope.AccessToken, nil
}
