package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMetricsHandler(t *testing.T) {
	m := NewMetrics()
	m.RecordHit("docker", "manifests")
	m.RecordMiss("docker", "blobs")
	m.RecordUpstreamError("ghcr")
	m.RecordWriterError("docker")
	m.AddBytesServed("docker", 1024)

	rr := httptest.NewRecorder()
	m.Handler().ServeHTTP(rr, httptest.NewRequest("GET", "/metrics", nil))
	body := rr.Body.String()

	for _, want := range []string{
		"aocr_mirror_cache_total",
		`outcome="hit"`,
		`outcome="miss"`,
		"aocr_mirror_upstream_errors_total",
		"aocr_mirror_writer_errors_total",
		"aocr_mirror_bytes_served_total",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("metrics body missing %q:\n%s", want, body)
		}
	}
}

func TestEscapeLabel(t *testing.T) {
	if got := escapeLabel(`a"b\c`); got != `a\"b\\c` {
		t.Fatalf("escapeLabel = %q", got)
	}
}

func TestSplitTwo(t *testing.T) {
	left, right := splitTwo("docker|manifests", '|')
	if left != "docker" || right != "manifests" {
		t.Fatalf("splitTwo = %q / %q", left, right)
	}
	left, right = splitTwo("nosep", '|')
	if left != "nosep" || right != "" {
		t.Fatalf("no-sep splitTwo = %q / %q", left, right)
	}
}

func TestAddBytesServedIgnoresNonPositive(t *testing.T) {
	m := NewMetrics()
	m.AddBytesServed("docker", 0)
	m.AddBytesServed("docker", -1)
	rr := httptest.NewRecorder()
	m.Handler().ServeHTTP(rr, httptest.NewRequest("GET", "/metrics", nil))
	if strings.Contains(rr.Body.String(), `{upstream="docker"} 1`) ||
		strings.Contains(rr.Body.String(), `{upstream="docker"} 0`) {
		t.Fatal("expected no bytes_served counter value for non-positive increments")
	}
}
