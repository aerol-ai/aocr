package main

import (
	"context"
	"net/http"
	"testing"
)

type stubUpstream struct {
	slug string
	host string
}

func (s *stubUpstream) Slug() string { return s.slug }
func (s *stubUpstream) Host() string { return s.host }
func (s *stubUpstream) NormalizeRepository(segments []string) (string, string, error) {
	repo := ""
	for i, seg := range segments {
		if i > 0 {
			repo += "/"
		}
		repo += seg
	}
	return repo, s.slug + "/" + repo, nil
}
func (s *stubUpstream) AcquireToken(_ context.Context, _ *http.Client, _ string) (string, error) {
	return "", nil
}

func TestResolve(t *testing.T) {
	reg := NewRegistry(
		&stubUpstream{slug: "docker", host: "registry-1.docker.io"},
		&stubUpstream{slug: "ghcr", host: "ghcr.io"},
		&stubUpstream{slug: "quay", host: "quay.io"},
	)

	tests := []struct {
		name        string
		path        string
		wantSlug    string
		wantRepo    string
		wantStorage string
		wantRef     string
		wantRes     string
		wantErr     error
	}{
		{
			name:        "docker library shortcut single segment",
			path:        "/v2/library/redis/manifests/7",
			wantSlug:    "docker",
			wantRepo:    "library/redis",
			wantStorage: "mirror/docker/library/redis",
			wantRef:     "7",
			wantRes:     "manifests",
		},
		{
			name:        "docker namespaced user repo",
			path:        "/v2/bitnami/postgresql/blobs/sha256:abcd",
			wantSlug:    "docker",
			wantRepo:    "bitnami/postgresql",
			wantStorage: "mirror/docker/bitnami/postgresql",
			wantRef:     "sha256:abcd",
			wantRes:     "blobs",
		},
		{
			name:        "explicit ghcr selection",
			path:        "/v2/_/ghcr/aerol-ai/sandbox/manifests/v1",
			wantSlug:    "ghcr",
			wantRepo:    "aerol-ai/sandbox",
			wantStorage: "mirror/ghcr/aerol-ai/sandbox",
			wantRef:     "v1",
			wantRes:     "manifests",
		},
		{
			name:        "explicit quay multi-segment repo with a 'blobs' segment in the name",
			path:        "/v2/_/quay/foo/blobsy/manifests/latest",
			wantSlug:    "quay",
			wantRepo:    "foo/blobsy",
			wantStorage: "mirror/quay/foo/blobsy",
			wantRef:     "latest",
			wantRes:     "manifests",
		},
		{
			name:    "unknown explicit upstream is rejected",
			path:    "/v2/_/notreal/foo/bar/manifests/latest",
			wantErr: ErrUnknownUpstream,
		},
		{
			name:    "missing /v2/ prefix is rejected",
			path:    "/healthz",
			wantErr: ErrNotRegistryRequest,
		},
		{
			name:    "no /manifests/ or /blobs/ tail is rejected",
			path:    "/v2/library/redis/tags/list",
			wantErr: ErrNotRegistryRequest,
		},
		{
			name:    "underscore-only without slug is unknown upstream",
			path:    "/v2/_/manifests/latest",
			wantErr: ErrUnknownUpstream,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			resolved, err := Resolve(reg, tc.path)
			if tc.wantErr != nil {
				if err == nil || err.Error() != tc.wantErr.Error() {
					t.Fatalf("want err %v, got %v", tc.wantErr, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected err: %v", err)
			}
			if resolved.Upstream.Slug() != tc.wantSlug {
				t.Errorf("slug: want %s, got %s", tc.wantSlug, resolved.Upstream.Slug())
			}
			if resolved.Repository != tc.wantRepo {
				t.Errorf("repo: want %s, got %s", tc.wantRepo, resolved.Repository)
			}
			if resolved.Storage != tc.wantStorage {
				t.Errorf("storage: want %s, got %s", tc.wantStorage, resolved.Storage)
			}
			if resolved.Reference != tc.wantRef {
				t.Errorf("ref: want %s, got %s", tc.wantRef, resolved.Reference)
			}
			if resolved.Resource != tc.wantRes {
				t.Errorf("resource: want %s, got %s", tc.wantRes, resolved.Resource)
			}
		})
	}
}

func TestDockerHubNormalize(t *testing.T) {
	d := &DockerHub{}

	repo, storage, err := d.NormalizeRepository([]string{"redis"})
	if err != nil {
		t.Fatalf("redis: %v", err)
	}
	if repo != "library/redis" || storage != "docker/library/redis" {
		t.Errorf("single-seg: got repo=%q storage=%q", repo, storage)
	}

	repo, storage, err = d.NormalizeRepository([]string{"bitnami", "postgresql"})
	if err != nil {
		t.Fatalf("bitnami: %v", err)
	}
	if repo != "bitnami/postgresql" || storage != "docker/bitnami/postgresql" {
		t.Errorf("multi-seg: got repo=%q storage=%q", repo, storage)
	}
}

func TestGHCRNormalizeRequiresTwoSegments(t *testing.T) {
	g := &GHCR{}
	if _, _, err := g.NormalizeRepository([]string{"justone"}); err == nil {
		t.Fatalf("expected error for single-segment ghcr repo")
	}
	repo, storage, err := g.NormalizeRepository([]string{"aerol-ai", "sandbox"})
	if err != nil {
		t.Fatalf("ok: %v", err)
	}
	if repo != "aerol-ai/sandbox" || storage != "ghcr/aerol-ai/sandbox" {
		t.Errorf("got repo=%q storage=%q", repo, storage)
	}
}
