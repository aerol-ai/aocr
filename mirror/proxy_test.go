package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeWriter implements the bare minimum of the Distribution upload protocol:
// POST /v2/<repo>/blobs/uploads/   -> 202 Accepted, Location: /upload/<id>
// PATCH /upload/<id>               -> 202 Accepted, accumulates body
// PUT   /upload/<id>?digest=<d>    -> 201 Created
// HEAD  /v2/<repo>/blobs/<d>       -> 404 until uploaded, 200 with bytes after
// PUT   /v2/<repo>/manifests/<r>   -> 201 Created
// HEAD  /v2/<repo>/manifests/<r>   -> 404 until put, 200 after
// GET   /v2/<repo>/{manifests,blobs}/<r> -> serves stored bytes
type fakeWriter struct {
	mu        sync.Mutex
	manifests map[string][]byte // key: storage|ref
	manifestCT map[string]string
	blobs     map[string][]byte // key: storage|digest
	uploads   map[string][]byte // key: upload id
	nextID    int
}

func newFakeWriter() *fakeWriter {
	return &fakeWriter{
		manifests:  make(map[string][]byte),
		manifestCT: make(map[string]string),
		blobs:      make(map[string][]byte),
		uploads:    make(map[string][]byte),
	}
}

func (fw *fakeWriter) Server(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case strings.HasPrefix(path, "/upload/") && r.Method == http.MethodPatch:
			id := strings.TrimPrefix(path, "/upload/")
			body, _ := io.ReadAll(r.Body)
			fw.mu.Lock()
			fw.uploads[id] = append(fw.uploads[id], body...)
			fw.mu.Unlock()
			w.Header().Set("Location", "/upload/"+id)
			w.WriteHeader(http.StatusAccepted)
		case strings.HasPrefix(path, "/upload/") && r.Method == http.MethodPut:
			id := strings.TrimPrefix(path, "/upload/")
			digest := r.URL.Query().Get("digest")
			fw.mu.Lock()
			data := fw.uploads[id]
			delete(fw.uploads, id)
			// store under any repo: in this fake we look it up later via the storage path embedded in Location; for simplicity we stash under the digest only and serve when any GET arrives.
			fw.blobs["any|"+digest] = data
			fw.mu.Unlock()
			w.WriteHeader(http.StatusCreated)
		case strings.HasSuffix(path, "/blobs/uploads/") && r.Method == http.MethodPost:
			fw.mu.Lock()
			fw.nextID++
			id := "u" + itoa(fw.nextID)
			fw.uploads[id] = nil
			fw.mu.Unlock()
			w.Header().Set("Location", "/upload/"+id)
			w.WriteHeader(http.StatusAccepted)
		case strings.Contains(path, "/manifests/"):
			storage, ref := splitStorageAndRef(path, "/manifests/")
			key := storage + "|" + ref
			fw.mu.Lock()
			defer fw.mu.Unlock()
			switch r.Method {
			case http.MethodHead, http.MethodGet:
				body, ok := fw.manifests[key]
				if !ok {
					w.WriteHeader(http.StatusNotFound)
					return
				}
				w.Header().Set("Content-Type", fw.manifestCT[key])
				w.Header().Set("Docker-Content-Digest", "sha256:"+sha256Hex(body))
				w.Header().Set("Content-Length", itoa(len(body)))
				if r.Method == http.MethodHead {
					w.WriteHeader(http.StatusOK)
					return
				}
				w.WriteHeader(http.StatusOK)
				w.Write(body)
			case http.MethodPut:
				body, _ := io.ReadAll(r.Body)
				fw.manifests[key] = body
				fw.manifestCT[key] = r.Header.Get("Content-Type")
				w.WriteHeader(http.StatusCreated)
			default:
				w.WriteHeader(http.StatusMethodNotAllowed)
			}
		case strings.Contains(path, "/blobs/"):
			_, digest := splitStorageAndRef(path, "/blobs/")
			fw.mu.Lock()
			body, ok := fw.blobs["any|"+digest]
			fw.mu.Unlock()
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Length", itoa(len(body)))
			w.Header().Set("Content-Type", "application/octet-stream")
			if r.Method == http.MethodHead {
				w.WriteHeader(http.StatusOK)
				return
			}
			w.WriteHeader(http.StatusOK)
			w.Write(body)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func splitStorageAndRef(path, sep string) (string, string) {
	idx := strings.LastIndex(path, sep)
	if idx < 0 {
		return "", ""
	}
	storage := strings.TrimPrefix(path[:idx], "/v2/")
	ref := path[idx+len(sep):]
	return storage, ref
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	neg := false
	if n < 0 {
		neg = true
		n = -n
	}
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// fakeUpstream serves one manifest and one blob for "library/redis", tagged
// "7". It tracks how many times each was fetched so tests can assert that the
// second mirror request did not call out.
type fakeUpstream struct {
	manifestBody []byte
	blobBody     []byte
	manifestHits int
	blobHits     int
	mu           sync.Mutex
}

func (fu *fakeUpstream) Server(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/library/redis/manifests/7":
			fu.mu.Lock()
			fu.manifestHits++
			fu.mu.Unlock()
			w.Header().Set("Content-Type", "application/vnd.docker.distribution.manifest.v2+json")
			w.Header().Set("Docker-Content-Digest", "sha256:"+sha256Hex(fu.manifestBody))
			w.Header().Set("Content-Length", itoa(len(fu.manifestBody)))
			w.WriteHeader(http.StatusOK)
			w.Write(fu.manifestBody)
		case "/v2/library/redis/blobs/sha256:" + sha256Hex(fu.blobBody):
			fu.mu.Lock()
			fu.blobHits++
			fu.mu.Unlock()
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("Content-Length", itoa(len(fu.blobBody)))
			w.WriteHeader(http.StatusOK)
			w.Write(fu.blobBody)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func TestProxyEndToEndCacheMissThenHit(t *testing.T) {
	upstream := &fakeUpstream{
		manifestBody: []byte(`{"schemaVersion":2}`),
		blobBody:     []byte("hello blob"),
	}
	upstreamServer := upstream.Server(t)
	defer upstreamServer.Close()

	writer := newFakeWriter()
	writerServer := writer.Server(t)
	defer writerServer.Close()

	upstreamHost := strings.TrimPrefix(upstreamServer.URL, "http://")
	// Use a stub upstream whose Host() points at the fake upstream. The proxy
	// builds HTTPS URLs, so we override the transport to rewrite scheme+host.
	cfg := &Config{
		ListenAddr:           ":0",
		WriterAddr:           writerServer.URL,
		UserAgent:            "test",
		TokenCacheTTLSeconds: 60,
	}
	reg := NewRegistry(&stubUpstream{slug: "docker", host: upstreamHost})
	httpClient := &http.Client{Transport: &rewriteToHTTP{base: http.DefaultTransport, replaceHost: upstreamHost}}
	wr := NewWriter(cfg, &http.Client{})
	metrics := NewMetrics()
	proxy := NewProxy(cfg, reg, httpClient, wr, metrics)

	srv := httptest.NewServer(proxy.Routes())
	defer srv.Close()

	// First manifest request: miss -> upstream + writer PUT.
	resp, err := http.Get(srv.URL + "/v2/library/redis/manifests/7")
	if err != nil {
		t.Fatalf("manifest GET: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(body) != `{"schemaVersion":2}` {
		t.Fatalf("manifest miss: status=%d body=%q", resp.StatusCode, string(body))
	}
	if upstream.manifestHits != 1 {
		t.Fatalf("expected 1 upstream manifest hit, got %d", upstream.manifestHits)
	}

	// Second manifest request: should hit the writer cache.
	resp, err = http.Get(srv.URL + "/v2/library/redis/manifests/7")
	if err != nil {
		t.Fatalf("manifest GET #2: %v", err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if upstream.manifestHits != 1 {
		t.Fatalf("expected upstream NOT to be hit again, got %d hits", upstream.manifestHits)
	}

	// First blob request: miss -> upstream stream tee -> writer upload.
	blobDigest := "sha256:" + sha256Hex(upstream.blobBody)
	resp, err = http.Get(srv.URL + "/v2/library/redis/blobs/" + blobDigest)
	if err != nil {
		t.Fatalf("blob GET: %v", err)
	}
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(body) != "hello blob" {
		t.Fatalf("blob miss: status=%d body=%q", resp.StatusCode, string(body))
	}
	if upstream.blobHits != 1 {
		t.Fatalf("expected 1 upstream blob hit, got %d", upstream.blobHits)
	}

	// Second blob request: should hit cache.
	resp, err = http.Get(srv.URL + "/v2/library/redis/blobs/" + blobDigest)
	if err != nil {
		t.Fatalf("blob GET #2: %v", err)
	}
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "hello blob" {
		t.Fatalf("blob hit: body=%q", string(body))
	}
	if upstream.blobHits != 1 {
		t.Fatalf("expected upstream blob NOT to be hit again, got %d", upstream.blobHits)
	}
}

// rewriteToHTTP intercepts the proxy's HTTPS requests against the fake
// upstream host and demotes them to plain HTTP against httptest.
type rewriteToHTTP struct {
	base        http.RoundTripper
	replaceHost string
}

func (r *rewriteToHTTP) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Host == r.replaceHost {
		req.URL.Scheme = "http"
	}
	return r.base.RoundTrip(req)
}

// TestProxyBlobFailSoftWhenWriterDown is the regression for the bug where a
// dead writer sidecar (e.g. S3 endpoint misconfigured to a non-existent
// "minio:9000" host) caused docker pulls to hang forever instead of failing
// to cache. The proxy must still stream the full blob to the client; only
// the cache write should be lost.
func TestProxyBlobFailSoftWhenWriterDown(t *testing.T) {
	upstream := &fakeUpstream{
		manifestBody: []byte(`{"schemaVersion":2}`),
		// Make the body large enough that io.Copy will issue multiple writes —
		// the bug manifests on the *first* pipeW.Write after the upload goroutine
		// has failed, so even a small body triggers it, but a larger body proves
		// the client keeps receiving after the cache breaks.
		blobBody: bytes.Repeat([]byte("A"), 256*1024),
	}
	upstreamServer := upstream.Server(t)
	defer upstreamServer.Close()

	// Failing writer: 500 on every POST blobs/uploads init, 404 on HEAD so the
	// proxy always treats the blob as a cache miss.
	failingWriter := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		http.Error(w, "s3 unreachable", http.StatusInternalServerError)
	}))
	defer failingWriter.Close()

	upstreamHost := strings.TrimPrefix(upstreamServer.URL, "http://")
	cfg := &Config{
		ListenAddr:           ":0",
		WriterAddr:           failingWriter.URL,
		UserAgent:            "test",
		TokenCacheTTLSeconds: 60,
	}
	reg := NewRegistry(&stubUpstream{slug: "docker", host: upstreamHost})
	httpClient := &http.Client{Transport: &rewriteToHTTP{base: http.DefaultTransport, replaceHost: upstreamHost}}
	wr := NewWriter(cfg, &http.Client{})
	metrics := NewMetrics()
	proxy := NewProxy(cfg, reg, httpClient, wr, metrics)

	srv := httptest.NewServer(proxy.Routes())
	defer srv.Close()

	blobDigest := "sha256:" + sha256Hex(upstream.blobBody)

	// Bound the test so the previous bug (infinite hang) fails fast instead
	// of timing out the whole test suite.
	type result struct {
		body []byte
		code int
		err  error
	}
	done := make(chan result, 1)
	go func() {
		resp, err := http.Get(srv.URL + "/v2/library/redis/blobs/" + blobDigest)
		if err != nil {
			done <- result{err: err}
			return
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		done <- result{body: body, code: resp.StatusCode, err: err}
	}()

	select {
	case res := <-done:
		if res.err != nil {
			t.Fatalf("client GET errored: %v", res.err)
		}
		if res.code != 200 {
			t.Fatalf("expected 200 from proxy, got %d", res.code)
		}
		if len(res.body) != len(upstream.blobBody) {
			t.Fatalf("body length mismatch: got %d, want %d", len(res.body), len(upstream.blobBody))
		}
		if !bytes.Equal(res.body, upstream.blobBody) {
			t.Fatalf("body bytes mismatch")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("client GET hung — writer failure should not deadlock the client (regression of mirror hang bug)")
	}
}
