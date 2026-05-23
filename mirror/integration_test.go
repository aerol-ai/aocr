//go:build integration

// Integration test for the mirror proxy against a real Distribution v2
// writer container. The unit tests in proxy_test.go simulate Distribution's
// referential validation with a strict fake; this test runs the same flow
// against the actual `registry:2.8.3` image used in production to catch
// behavior the fake doesn't model (manifest body-digest validation, real
// notifications, real auth-protocol nits).
//
// Run with:  go test -tags=integration -timeout=2m ./...
// Requires:  docker available on PATH; ability to pull registry:2.8.3.
//
// Skipped (not failed) if Docker is missing — keeps the file safe to
// vendor into restricted CI environments.
package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestIntegrationProxyAgainstRealDistribution(t *testing.T) {
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker not in PATH; skipping integration test")
	}

	containerName := fmt.Sprintf("aocr-mirror-it-%d", time.Now().UnixNano())
	t.Cleanup(func() {
		_ = exec.Command("docker", "rm", "-f", containerName).Run()
	})

	// Start a fresh Distribution writer. Filesystem storage, deletes enabled
	// so the test doesn't poison subsequent runs even if cleanup misses.
	out, err := exec.Command("docker", "run", "-d",
		"--rm",
		"--name", containerName,
		"-P",
		"-e", "REGISTRY_STORAGE_DELETE_ENABLED=true",
		"registry:2.8.3",
	).CombinedOutput()
	if err != nil {
		t.Fatalf("docker run registry:2.8.3: %v\n%s", err, out)
	}

	writerPort, err := discoverDockerPort(containerName, "5000/tcp")
	if err != nil {
		t.Fatalf("discover registry port: %v", err)
	}
	writerURL := "http://127.0.0.1:" + writerPort

	if err := waitForReady(writerURL+"/v2/", 30*time.Second); err != nil {
		logs, _ := exec.Command("docker", "logs", containerName).CombinedOutput()
		t.Fatalf("registry never became ready: %v\n%s", err, logs)
	}

	upstream := newIndexUpstream()
	upstreamServer := upstream.Server(t)
	defer upstreamServer.Close()

	upstreamHost := strings.TrimPrefix(upstreamServer.URL, "http://")
	cfg := &Config{
		ListenAddr:           ":0",
		WriterAddr:           writerURL,
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

	resp, err := http.Get(srv.URL + "/v2/library/multi/manifests/latest")
	if err != nil {
		t.Fatalf("index GET through proxy: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("index GET: status=%d body=%s", resp.StatusCode, string(body))
	}

	// The proxy returns immediately; the warm runs in the background. Poll
	// the real Distribution until the index tag lands. If our ordering is
	// wrong, Distribution will reject the index PUT with 400
	// MANIFEST_BLOB_UNKNOWN and the tag will never appear — the deadline
	// would trip and the registry logs (printed on failure) will show the
	// rejection.
	indexHEAD := writerURL + "/v2/mirror/docker/library/multi/manifests/latest"
	if err := pollHEAD(indexHEAD, 30*time.Second); err != nil {
		logs, _ := exec.Command("docker", "logs", containerName).CombinedOutput()
		t.Fatalf("index never landed in writer: %v\nregistry logs:\n%s", err, logs)
	}

	// Verify every dependency is present. If any is missing the proxy did
	// reach Distribution but with the wrong order, and Distribution would
	// have already 200'd the index PUT (which means dependencies WERE
	// present at PUT time but something else dropped them). The HEAD probe
	// catches that asymmetry.
	checks := []struct {
		label string
		path  string
	}{
		{"child manifest A", "manifests/" + upstream.mfstDigestA},
		{"child manifest B", "manifests/" + upstream.mfstDigestB},
		{"config blob", "blobs/" + upstream.configDigest},
		{"layer blob", "blobs/" + upstream.layerDigest},
	}
	for _, c := range checks {
		url := writerURL + "/v2/mirror/docker/library/multi/" + c.path
		r, err := http.Head(url)
		if err != nil {
			t.Fatalf("HEAD %s (%s): %v", c.label, url, err)
		}
		r.Body.Close()
		if r.StatusCode != http.StatusOK {
			logs, _ := exec.Command("docker", "logs", containerName).CombinedOutput()
			t.Fatalf("HEAD %s (%s): status=%d\nregistry logs:\n%s", c.label, url, r.StatusCode, logs)
		}
	}
}

// discoverDockerPort returns the host-side port that Docker mapped for
// `internalPort` (e.g. "5000/tcp") in the named container.
func discoverDockerPort(name, internalPort string) (string, error) {
	out, err := exec.Command("docker", "port", name, internalPort).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("docker port %s %s: %v\n%s", name, internalPort, err, out)
	}
	// Output: "0.0.0.0:32768\n[::]:32768\n" — take the first line, last colon-segment.
	first := strings.SplitN(strings.TrimSpace(string(out)), "\n", 2)[0]
	idx := strings.LastIndex(first, ":")
	if idx < 0 {
		return "", fmt.Errorf("unexpected docker port output: %q", string(out))
	}
	return first[idx+1:], nil
}

// waitForReady polls `url` until it responds with 2xx or 401 (Distribution
// returns 401 when auth is required but the endpoint is alive). A 200 from
// /v2/ means the registry is fully up.
func waitForReady(url string, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode/100 == 2 || resp.StatusCode == http.StatusUnauthorized {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
	return fmt.Errorf("timeout after %s", timeout)
}

// pollHEAD waits for `url` to return 200 within timeout.
func pollHEAD(url string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		r, err := http.Head(url)
		if err == nil {
			r.Body.Close()
			if r.StatusCode == http.StatusOK {
				return nil
			}
		}
		time.Sleep(150 * time.Millisecond)
	}
	return fmt.Errorf("HEAD %s never returned 200 within %s", url, timeout)
}
