package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
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

// handleManifest serves the requested manifest and warms the writer cache
// with everything it depends on, so a subsequent pull is fully served from
// S3 and the `push` notification fires (which is what populates hooks'
// /v1/images list).
//
// Distribution validates referential integrity on manifest PUT: an image
// manifest is rejected (MANIFEST_BLOB_UNKNOWN) until its config + layer
// blobs exist in the same repo. Pushing the manifest before its layers
// therefore silently fails and leaves _manifests/ empty in S3 — exactly the
// bug that produced the original "blobs cached but no row in /v1/images"
// symptom. The fix is to warm dependencies first:
//
//   - Image manifest (schemaV2 / OCI image manifest): warm config + layers
//     synchronously, then PUT, then serve. The client's wall time is
//     unchanged — the blob fetches that follow become cache hits.
//   - Index / manifest list: serve immediately, warm children + PUT the
//     index in the background. Indexes can fan out to 16+ per-arch
//     manifests; blocking the client on a full server-side fetch of every
//     architecture is the wrong default for a pull-through cache.
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

	parsed, parseErr := parseManifestDescriptors(body, upstreamCT)
	if parseErr != nil {
		log.Printf("mirror: cannot parse manifest for %s/%s ref=%s ct=%q: %v — cache skipped",
			res.Upstream.Slug(), res.Repository, res.Reference, upstreamCT, parseErr)
	}

	switch {
	case parseErr != nil:
		// Unknown schema: don't try to warm anything we don't understand.
		// The manifest body is still served to the client below.
	case parsed.isIndex:
		bodyCopy := append([]byte(nil), body...)
		warmRes := res
		warmCT := upstreamCT
		go func() {
			bgCtx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
			defer cancel()
			p.warmAndPutManifest(bgCtx, warmRes, bodyCopy, warmCT, parsed)
		}()
	default:
		p.warmAndPutManifest(ctx, res, body, upstreamCT, parsed)
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

// warmAndPutManifest ensures every dependency the manifest references is in
// the writer cache, then PUTs the manifest itself. Errors are logged + metric
// only; callers don't need to react.
func (p *Proxy) warmAndPutManifest(ctx context.Context, res Resolved, body []byte, contentType string, parsed parsedManifest) {
	if parsed.isIndex {
		if err := p.warmIndexChildren(ctx, res, parsed.manifests); err != nil {
			log.Printf("mirror: index child warm failed for %s/%s ref=%s: %v",
				res.Upstream.Slug(), res.Repository, res.Reference, err)
			p.metrics.RecordWriterError(res.Upstream.Slug())
			// Skip the index PUT — Distribution will reject it without all
			// children present anyway. Better to leave the cache consistent.
			return
		}
	} else {
		descs := make([]descriptor, 0, len(parsed.layers)+1)
		if parsed.config.Digest != "" {
			descs = append(descs, parsed.config)
		}
		descs = append(descs, parsed.layers...)
		if err := p.warmBlobs(ctx, res, descs); err != nil {
			log.Printf("mirror: blob warm failed for %s/%s ref=%s: %v",
				res.Upstream.Slug(), res.Repository, res.Reference, err)
			p.metrics.RecordWriterError(res.Upstream.Slug())
			return
		}
	}

	if err := p.writer.PutManifest(ctx, res.Storage, res.Reference, contentType, body); err != nil {
		log.Printf("mirror: manifest PUT failed for %s/%s ref=%s: %v",
			res.Upstream.Slug(), res.Repository, res.Reference, err)
		p.metrics.RecordWriterError(res.Upstream.Slug())
	}
}

// warmIndexChildren fetches every per-arch manifest referenced by an index
// and recursively warms it (config + layers + PUT). Distribution accepts the
// parent index PUT only after each child is on disk. Children are fetched
// concurrently with a small fan-out cap so a 16-arch index doesn't fire 16
// simultaneous upstream connections.
func (p *Proxy) warmIndexChildren(ctx context.Context, res Resolved, children []descriptor) error {
	const fanOut = 4
	sem := make(chan struct{}, fanOut)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error

	for _, child := range children {
		child := child
		if child.Digest == "" {
			continue
		}
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			return ctx.Err()
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }()

			childRes := res
			childRes.Reference = child.Digest

			if _, _, present, _ := p.writer.HeadManifest(ctx, childRes.Storage, childRes.Reference); present {
				return
			}
			childBody, _, childCT, err := p.fetchManifestFromUpstream(ctx, childRes, "")
			if err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = fmt.Errorf("fetch child %s: %w", child.Digest, err)
				}
				mu.Unlock()
				return
			}
			parsedChild, perr := parseManifestDescriptors(childBody, childCT)
			if perr != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = fmt.Errorf("parse child %s: %w", child.Digest, perr)
				}
				mu.Unlock()
				return
			}
			p.warmAndPutManifest(ctx, childRes, childBody, childCT, parsedChild)
		}()
	}
	wg.Wait()
	return firstErr
}

// warmBlobs ensures every blob in descs is present in the writer cache,
// fetching missing ones directly from upstream. Bounded concurrency for the
// same reason as warmIndexChildren.
func (p *Proxy) warmBlobs(ctx context.Context, res Resolved, descs []descriptor) error {
	const fanOut = 4
	sem := make(chan struct{}, fanOut)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error

	for _, d := range descs {
		d := d
		if d.Digest == "" {
			continue
		}
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			return ctx.Err()
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }()

			if _, present, _ := p.writer.HeadBlob(ctx, res.Storage, d.Digest); present {
				return
			}
			blobRes := res
			blobRes.Reference = d.Digest
			if err := p.uploadBlobFromUpstream(ctx, blobRes); err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = fmt.Errorf("upload blob %s: %w", d.Digest, err)
				}
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	return firstErr
}

// uploadBlobFromUpstream streams a blob straight from upstream into the
// writer cache, without involving a client. Used by the warm path when the
// client hasn't (yet) asked for the blob itself.
func (p *Proxy) uploadBlobFromUpstream(ctx context.Context, res Resolved) error {
	resp, err := p.openUpstreamBlob(ctx, res)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		return fmt.Errorf("upstream blob %s returned %d: %s", res.Reference, resp.StatusCode, string(msg))
	}
	size := resp.ContentLength
	if size <= 0 {
		return fmt.Errorf("upstream blob %s lacked Content-Length", res.Reference)
	}
	return p.writer.UploadBlob(ctx, res.Storage, res.Reference, size, resp.Body)
}

// descriptor is the subset of OCI/Docker descriptor fields the warm path
// needs. We deliberately ignore platform, urls, annotations etc.
type descriptor struct {
	MediaType string `json:"mediaType"`
	Digest    string `json:"digest"`
	Size      int64  `json:"size"`
}

type parsedManifest struct {
	isIndex   bool
	manifests []descriptor // index children
	config    descriptor   // image manifest config blob
	layers    []descriptor // image manifest layer blobs
}

func parseManifestDescriptors(body []byte, contentType string) (parsedManifest, error) {
	ct := strings.ToLower(contentType)
	if strings.Contains(ct, "manifest.list") || strings.Contains(ct, "image.index") {
		var idx struct {
			Manifests []descriptor `json:"manifests"`
		}
		if err := json.Unmarshal(body, &idx); err != nil {
			return parsedManifest{}, err
		}
		return parsedManifest{isIndex: true, manifests: idx.Manifests}, nil
	}
	var img struct {
		Config descriptor   `json:"config"`
		Layers []descriptor `json:"layers"`
	}
	if err := json.Unmarshal(body, &img); err != nil {
		return parsedManifest{}, err
	}
	return parsedManifest{config: img.Config, layers: img.Layers}, nil
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

	// Tee the upstream body into both the client response and the writer
	// sidecar's upload. If the writer fails (down, S3 misconfigured, slow),
	// the client must still receive the full body — caching is best-effort.
	//
	// The previous implementation used io.MultiWriter(w, pipeW). When
	// UploadBlob errored before reading pipeR (e.g. POST init returned 500),
	// nothing drained the pipe, pipeW.Write blocked forever, and the docker
	// client hung mid-pull. We now (a) close pipeR with the upload error so
	// subsequent pipe writes return immediately, and (b) use a tee writer
	// that swallows cache-side failures and keeps streaming to the client.
	pipeR, pipeW := io.Pipe()
	uploadErrCh := make(chan error, 1)
	go func() {
		err := p.writer.UploadBlob(ctx, res.Storage, res.Reference, size, pipeR)
		if err != nil {
			// Unblock any pending pipeW.Write so io.Copy below returns.
			_ = pipeR.CloseWithError(err)
		}
		uploadErrCh <- err
	}()

	tee := &resilientTee{client: w, cache: pipeW}
	n, copyErr := io.Copy(tee, upstreamResp.Body)
	closeErr := pipeW.Close()
	uploadErr := <-uploadErrCh
	p.metrics.AddBytesServed(res.Upstream.Slug(), n)

	if copyErr != nil || closeErr != nil || uploadErr != nil || tee.cacheBroken {
		log.Printf("mirror: blob cache write degraded for %s/%s digest=%s copyErr=%v closeErr=%v uploadErr=%v cacheBroken=%v",
			res.Upstream.Slug(), res.Repository, res.Reference, copyErr, closeErr, uploadErr, tee.cacheBroken)
		p.metrics.RecordWriterError(res.Upstream.Slug())
	}
}

// resilientTee writes every chunk to the client and best-effort to the cache.
// Once a cache write fails, further chunks skip the cache so a wedged writer
// sidecar cannot stall the client-side stream. io.Copy semantics require that
// Write returns n == len(p) on success; we only ever report the client's count
// so a short cache write is invisible to the caller.
type resilientTee struct {
	client      io.Writer
	cache       io.Writer
	cacheBroken bool
}

func (t *resilientTee) Write(p []byte) (int, error) {
	if !t.cacheBroken {
		if _, err := t.cache.Write(p); err != nil {
			t.cacheBroken = true
		}
	}
	return t.client.Write(p)
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
