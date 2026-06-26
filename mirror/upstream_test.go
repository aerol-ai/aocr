package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDockerHubNormalizeRepository(t *testing.T) {
	d := &DockerHub{}
	repo, storage, err := d.NormalizeRepository([]string{"redis"})
	if err != nil || repo != "library/redis" || storage != "docker/library/redis" {
		t.Fatalf("single segment: repo=%q storage=%q err=%v", repo, storage, err)
	}

	repo, storage, err = d.NormalizeRepository([]string{"grafana", "grafana"})
	if err != nil || repo != "grafana/grafana" || storage != "docker/grafana/grafana" {
		t.Fatalf("multi segment: repo=%q storage=%q err=%v", repo, storage, err)
	}

	_, _, err = d.NormalizeRepository(nil)
	if err == nil {
		t.Fatal("expected error for empty repository")
	}
}

func TestGHCRNormalizeRepository(t *testing.T) {
	g := &GHCR{}
	_, _, err := g.NormalizeRepository([]string{"onlyone"})
	if err == nil {
		t.Fatal("expected error for single segment")
	}

	repo, storage, err := g.NormalizeRepository([]string{"aerol-ai", "sandbox"})
	if err != nil || repo != "aerol-ai/sandbox" || storage != "ghcr/aerol-ai/sandbox" {
		t.Fatalf("repo=%q storage=%q err=%v", repo, storage, err)
	}
}

func TestK8sAcquireTokenEmpty(t *testing.T) {
	k := &K8sRegistry{}
	token, err := k.AcquireToken(context.Background(), http.DefaultClient, "pause")
	if err != nil || token != "" {
		t.Fatalf("token=%q err=%v", token, err)
	}
}

func TestFetchAnonymousBearer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"token":"abc123"}`))
	}))
	defer srv.Close()

	token, err := fetchAnonymousBearer(context.Background(), srv.Client(), srv.URL)
	if err != nil || token != "abc123" {
		t.Fatalf("token=%q err=%v", token, err)
	}
}

func TestFetchAnonymousBearerAccessTokenField(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"access_token":"from-access"}`))
	}))
	defer srv.Close()

	token, err := fetchAnonymousBearer(context.Background(), srv.Client(), srv.URL)
	if err != nil || token != "from-access" {
		t.Fatalf("token=%q err=%v", token, err)
	}
}

func TestFetchAnonymousBearerErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte("nope"))
	}))
	defer srv.Close()

	_, err := fetchAnonymousBearer(context.Background(), srv.Client(), srv.URL)
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("expected 401 error, got %v", err)
	}
}

func TestTokenCacheGet(t *testing.T) {
	cache := NewTokenCache(time.Minute)
	calls := 0
	token, err := cache.Get(context.Background(), "docker|library/redis", func() (string, error) {
		calls++
		return "cached-token", nil
	})
	if err != nil || token != "cached-token" || calls != 1 {
		t.Fatalf("first fetch token=%q calls=%d err=%v", token, calls, err)
	}

	token, err = cache.Get(context.Background(), "docker|library/redis", func() (string, error) {
		calls++
		return "other", nil
	})
	if err != nil || token != "cached-token" || calls != 1 {
		t.Fatalf("cached fetch token=%q calls=%d err=%v", token, calls, err)
	}
}

func TestGCRAndQuayNormalizeRepository(t *testing.T) {
	gcr := &GCR{}
	_, _, err := gcr.NormalizeRepository([]string{"only"})
	if err == nil {
		t.Fatal("expected gcr error")
	}

	quay := &Quay{}
	repo, storage, err := quay.NormalizeRepository([]string{"prometheus", "node-exporter"})
	if err != nil || repo != "prometheus/node-exporter" || storage != "quay/prometheus/node-exporter" {
		t.Fatalf("quay repo=%q storage=%q err=%v", repo, storage, err)
	}
}

func TestProxyRoutesBasics(t *testing.T) {
	writer := newFakeWriter()
	writerServer := writer.Server(t)
	defer writerServer.Close()

	cfg := &Config{
		ListenAddr:           ":0",
		WriterAddr:           writerServer.URL,
		UserAgent:            "test",
		TokenCacheTTLSeconds: 60,
	}
	reg := NewRegistry(&DockerHub{})
	proxy := NewProxy(cfg, reg, http.DefaultClient, NewWriter(cfg, http.DefaultClient), NewMetrics())
	srv := httptest.NewServer(proxy.Routes())
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/v2")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("/v2 status=%d err=%v", resp.StatusCode, err)
	}
	resp.Body.Close()

	resp, err = http.Get(srv.URL + "/healthz")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("/healthz status=%d err=%v", resp.StatusCode, err)
	}
	resp.Body.Close()

	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/v2/library/redis/manifests/latest", nil)
	resp, err = http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("POST status=%d err=%v", resp.StatusCode, err)
	}
	resp.Body.Close()

	resp, err = http.Get(srv.URL + "/v2/aocr/unknown/repo/manifests/latest")
	if err != nil || resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown upstream status=%d err=%v", resp.StatusCode, err)
	}
	resp.Body.Close()
}

func TestUpstreamSlugHost(t *testing.T) {
	cases := []struct {
		upstream Upstream
		slug     string
		host     string
	}{
		{&DockerHub{}, "docker", "registry-1.docker.io"},
		{&GHCR{}, "ghcr", "ghcr.io"},
		{&GCR{}, "gcr", "gcr.io"},
		{&Quay{}, "quay", "quay.io"},
		{&K8sRegistry{}, "k8s", "registry.k8s.io"},
	}
	for _, tc := range cases {
		if tc.upstream.Slug() != tc.slug || tc.upstream.Host() != tc.host {
			t.Fatalf("%T slug/host = %q/%q", tc.upstream, tc.upstream.Slug(), tc.upstream.Host())
		}
	}
}
