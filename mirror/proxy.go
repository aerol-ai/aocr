package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// manifestAcceptHeader covers the OCI and Docker manifest media types the
// proxy can faithfully cache. We include both single manifests and lists so a
// `docker pull` against the mirror gets the multi-arch shape the client
// expected from the upstream.
const manifestAcceptHeader = "application/vnd.oci.image.manifest.v1+json, " +
	"application/vnd.oci.image.index.v1+json, " +
	"application/vnd.docker.distribution.manifest.v2+json, " +
	"application/vnd.docker.distribution.manifest.list.v2+json"

// Proxy is the HTTP handler for the mirror. It serves the Distribution v2 read
// surface, opportunistically populating the writer sidecar on miss.
type Proxy struct {
	cfg          *Config
	registry     *Registry
	upstreamHTTP *http.Client
	writer       *Writer
	tokens       *TokenCache
	metrics      *Metrics
}

func NewProxy(cfg *Config, registry *Registry, upstreamHTTP *http.Client, writer *Writer, metrics *Metrics) *Proxy {
	return &Proxy{
		cfg:          cfg,
		registry:     registry,
		upstreamHTTP: upstreamHTTP,
		writer:       writer,
		tokens:       NewTokenCache(time.Duration(cfg.TokenCacheTTLSeconds) * time.Second),
		metrics:      metrics,
	}
}

func (p *Proxy) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v2/", p.handle)
	mux.HandleFunc("/v2", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Docker-Distribution-API-Version", "registry/2.0")
		w.WriteHeader(http.StatusOK)
	})
	mux.Handle("/metrics", p.metrics.Handler())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	return mux
}

func (p *Proxy) handle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	resolved, err := Resolve(p.registry, r.URL.Path)
	if err != nil {
		if errors.Is(err, ErrUnknownUpstream) {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		http.Error(w, "not a mirrored request", http.StatusBadRequest)
		return
	}

	switch resolved.Resource {
	case "manifests":
		p.handleManifest(w, r, resolved)
	case "blobs":
		p.handleBlob(w, r, resolved)
	default:
		http.Error(w, "unknown resource", http.StatusBadRequest)
	}
}

func (p *Proxy) handleManifest(w http.ResponseWriter, r *http.Request, res Resolved) {
	ctx := r.Context()

	digest, contentType, present, err := p.writer.HeadManifest(ctx, res.Storage, res.Reference)
	if err == nil && present {
		p.metrics.RecordHit(res.Upstream.Slug(), "manifests")
		p.streamManifestFromWriter(w, r, res, digest, contentType)
		return
	}
	p.metrics.RecordMiss(res.Upstream.Slug(), "manifests")

	body, upstreamDigest, upstreamCT, err := p.fetchManifestFromUpstream(ctx, res, r.Header.Get("Accept"))
	if err != nil {
		p.metrics.RecordUpstreamError(res.Upstream.Slug())
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	if err := p.writer.PutManifest(ctx, res.Storage, res.Reference, upstreamCT, body); err != nil {
		p.metrics.RecordWriterError(res.Upstream.Slug())
		// Cache write failed; still serve the response so the client makes progress.
	}

	w.Header().Set("Content-Type", upstreamCT)
	if upstreamDigest != "" {
		w.Header().Set("Docker-Content-Digest", upstreamDigest)
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("Docker-Distribution-API-Version", "registry/2.0")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	n, _ := w.Write(body)
	p.metrics.AddBytesServed(res.Upstream.Slug(), int64(n))
}

func (p *Proxy) streamManifestFromWriter(w http.ResponseWriter, r *http.Request, res Resolved, digest, contentType string) {
	target := fmt.Sprintf("%s/v2/%s/manifests/%s", p.writer.baseURL, res.Storage, res.Reference)
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target, nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	req.Header.Set("Accept", manifestAcceptHeader)
	p.writer.auth(req)
	resp, err := p.writer.client.Do(req)
	if err != nil {
		p.metrics.RecordWriterError(res.Upstream.Slug())
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	for k, vs := range resp.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	if r.Method == http.MethodHead {
		return
	}
	n, _ := io.Copy(w, resp.Body)
	p.metrics.AddBytesServed(res.Upstream.Slug(), n)
	_ = digest
	_ = contentType
}

func (p *Proxy) handleBlob(w http.ResponseWriter, r *http.Request, res Resolved) {
	ctx := r.Context()

	if !strings.HasPrefix(res.Reference, "sha256:") {
		http.Error(w, "blob reference must be a digest", http.StatusBadRequest)
		return
	}

	if _, present, err := p.writer.HeadBlob(ctx, res.Storage, res.Reference); err == nil && present {
		p.metrics.RecordHit(res.Upstream.Slug(), "blobs")
		p.streamBlobFromWriter(w, r, res)
		return
	}
	p.metrics.RecordMiss(res.Upstream.Slug(), "blobs")

	upstreamResp, err := p.openUpstreamBlob(ctx, res)
	if err != nil {
		p.metrics.RecordUpstreamError(res.Upstream.Slug())
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer upstreamResp.Body.Close()
	if upstreamResp.StatusCode/100 != 2 {
		body, _ := io.ReadAll(io.LimitReader(upstreamResp.Body, 4<<10))
		http.Error(w, fmt.Sprintf("upstream %d: %s", upstreamResp.StatusCode, string(body)), http.StatusBadGateway)
		return
	}

	size := upstreamResp.ContentLength

	// Two-pass for unknown-length blobs is unsafe (memory unbounded); only
	// large registries do this, and the spec strongly recommends Content-Length.
	if size <= 0 {
		http.Error(w, "upstream blob lacked Content-Length", http.StatusBadGateway)
		return
	}

	contentType := upstreamResp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("Docker-Content-Digest", res.Reference)
	w.Header().Set("Docker-Distribution-API-Version", "registry/2.0")
	w.WriteHeader(http.StatusOK)

	if r.Method == http.MethodHead {
		return
	}

	pipeR, pipeW := io.Pipe()
	uploadErrCh := make(chan error, 1)
	go func() {
		uploadErrCh <- p.writer.UploadBlob(ctx, res.Storage, res.Reference, size, pipeR)
	}()

	tee := io.MultiWriter(w, pipeW)
	n, copyErr := io.Copy(tee, upstreamResp.Body)
	closeErr := pipeW.Close()
	uploadErr := <-uploadErrCh
	p.metrics.AddBytesServed(res.Upstream.Slug(), n)

	if copyErr != nil || closeErr != nil || uploadErr != nil {
		p.metrics.RecordWriterError(res.Upstream.Slug())
	}
}

func (p *Proxy) streamBlobFromWriter(w http.ResponseWriter, r *http.Request, res Resolved) {
	target := fmt.Sprintf("%s/v2/%s/blobs/%s", p.writer.baseURL, res.Storage, res.Reference)
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target, nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	p.writer.auth(req)
	resp, err := p.writer.client.Do(req)
	if err != nil {
		p.metrics.RecordWriterError(res.Upstream.Slug())
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	for k, vs := range resp.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	if r.Method == http.MethodHead {
		return
	}
	n, _ := io.Copy(w, resp.Body)
	p.metrics.AddBytesServed(res.Upstream.Slug(), n)
}

// ---- upstream fetch helpers ---------------------------------------------

func (p *Proxy) fetchManifestFromUpstream(ctx context.Context, res Resolved, clientAccept string) (body []byte, digest, contentType string, err error) {
	accept := clientAccept
	if accept == "" {
		accept = manifestAcceptHeader
	}
	url := fmt.Sprintf("https://%s/v2/%s/manifests/%s", res.Upstream.Host(), res.Repository, res.Reference)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, "", "", err
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("User-Agent", p.cfg.UserAgent)
	if err := p.authorize(ctx, req, res); err != nil {
		return nil, "", "", err
	}

	resp, err := p.upstreamHTTP.Do(req)
	if err != nil {
		return nil, "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		return nil, "", "", fmt.Errorf("upstream manifest %s returned %d: %s", url, resp.StatusCode, string(msg))
	}
	body, err = io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, "", "", err
	}
	digest = resp.Header.Get("Docker-Content-Digest")
	if digest == "" {
		sum := sha256.Sum256(body)
		digest = "sha256:" + hex.EncodeToString(sum[:])
	}
	contentType = resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/vnd.docker.distribution.manifest.v2+json"
	}
	return body, digest, contentType, nil
}

func (p *Proxy) openUpstreamBlob(ctx context.Context, res Resolved) (*http.Response, error) {
	url := fmt.Sprintf("https://%s/v2/%s/blobs/%s", res.Upstream.Host(), res.Repository, res.Reference)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", p.cfg.UserAgent)
	if err := p.authorize(ctx, req, res); err != nil {
		return nil, err
	}
	return p.upstreamHTTP.Do(req)
}

func (p *Proxy) authorize(ctx context.Context, req *http.Request, res Resolved) error {
	key := res.Upstream.Slug() + ":" + res.Repository
	token, err := p.tokens.Get(ctx, key, func() (string, error) {
		return res.Upstream.AcquireToken(ctx, p.upstreamHTTP, res.Repository)
	})
	if err != nil {
		return fmt.Errorf("acquiring upstream token: %w", err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return nil
}

// keep io.Discard reference for readability in error paths (not used directly).
var _ = bytes.NewBuffer
