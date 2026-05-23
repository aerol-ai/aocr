package main

import (
	"errors"
	"strings"
)

// Resolved is the outcome of mapping a client request path to (upstream,
// upstream path, storage path).
//
//   - Upstream  : the registered Upstream that owns this request.
//   - Repository: the repository identifier *as seen by the upstream*
//     (e.g. "library/redis", "aerol-ai/foo").
//   - Storage   : the repository path the writer sidecar persists under
//     (e.g. "mirror/docker/library/redis"). The "mirror/" prefix is what causes
//     Phase 0's inferredProvenance() to tag rows as provenance='mirror'.
//   - Reference : the part after /manifests/ or /blobs/ (a digest, a tag, or a
//     blob upload session id).
//   - Resource  : "manifests" or "blobs".
type Resolved struct {
	Upstream   Upstream
	Repository string
	Storage    string
	Reference  string
	Resource   string
}

// Registry maps an upstream slug ("docker", "ghcr", "gcr", "quay", "k8s") to an
// Upstream implementation.
type Registry struct {
	upstreams map[string]Upstream
}

func NewRegistry(upstreams ...Upstream) *Registry {
	reg := &Registry{upstreams: make(map[string]Upstream, len(upstreams))}
	for _, u := range upstreams {
		reg.upstreams[u.Slug()] = u
	}
	return reg
}

func (r *Registry) Get(slug string) (Upstream, bool) {
	u, ok := r.upstreams[slug]
	return u, ok
}

// ErrUnknownUpstream is returned when an `/v2/_/<slug>/...` request names an
// upstream the proxy does not have registered.
var ErrUnknownUpstream = errors.New("mirror: unknown upstream")

// ErrNotRegistryRequest is returned when the path does not look like a
// Distribution v2 request the proxy should handle.
var ErrNotRegistryRequest = errors.New("mirror: not a registry request")

// Resolve parses a /v2/... request path and returns the resolved request, or
// an error describing why the path is not routable. Recognised shapes:
//
//	/v2/library/<repo>/manifests/<ref>   -> docker.io library namespace shortcut
//	/v2/library/<repo>/blobs/<digest>    -> docker.io library namespace shortcut
//	/v2/_/<slug>/<repo>/manifests/<ref>  -> explicit upstream selection
//	/v2/_/<slug>/<repo>/blobs/<digest>   -> explicit upstream selection
//
// Repository segments may themselves contain slashes (e.g. ghcr's
// `aerol-ai/foo/bar`), and the parser tolerates that.
func Resolve(reg *Registry, path string) (Resolved, error) {
	if !strings.HasPrefix(path, "/v2/") {
		return Resolved{}, ErrNotRegistryRequest
	}
	rest := strings.TrimPrefix(path, "/v2/")
	rest = strings.TrimPrefix(rest, "/")
	if rest == "" {
		return Resolved{}, ErrNotRegistryRequest
	}

	resource, ref, repoTail, ok := splitDistributionTail(rest)
	if !ok {
		return Resolved{}, ErrNotRegistryRequest
	}

	segments := strings.Split(repoTail, "/")
	if len(segments) == 0 || segments[0] == "" {
		return Resolved{}, ErrNotRegistryRequest
	}

	var slug string
	var repoSegments []string

	if segments[0] == "_" {
		if len(segments) < 3 {
			return Resolved{}, ErrUnknownUpstream
		}
		slug = segments[1]
		repoSegments = segments[2:]
	} else {
		slug = "docker"
		repoSegments = segments
	}

	upstream, ok := reg.Get(slug)
	if !ok {
		return Resolved{}, ErrUnknownUpstream
	}

	repository, storageRelative, err := upstream.NormalizeRepository(repoSegments)
	if err != nil {
		return Resolved{}, err
	}

	storage := "mirror/" + storageRelative

	return Resolved{
		Upstream:   upstream,
		Repository: repository,
		Storage:    storage,
		Reference:  ref,
		Resource:   resource,
	}, nil
}

// splitDistributionTail finds the last `/manifests/<ref>` or `/blobs/<ref>` in
// `rest` and returns (resource, ref, repoTail, ok). It uses the *last*
// occurrence so repository names that happen to contain "blobs" or "manifests"
// segments survive.
func splitDistributionTail(rest string) (resource, ref, repoTail string, ok bool) {
	for _, marker := range []string{"/manifests/", "/blobs/"} {
		idx := strings.LastIndex(rest, marker)
		if idx <= 0 {
			continue
		}
		repoTail = rest[:idx]
		resource = strings.Trim(marker, "/")
		ref = rest[idx+len(marker):]
		if ref == "" || repoTail == "" {
			return "", "", "", false
		}
		return resource, ref, repoTail, true
	}
	return "", "", "", false
}
