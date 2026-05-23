package main

import (
	"net/http"
	"strconv"
	"sync"
	"time"
)

// Metrics is a tiny in-process counter set, exported in Prometheus text format
// at /metrics. Keeping it homegrown avoids pulling in the full prom-client
// dependency tree for a service that emits ~10 series.
type Metrics struct {
	mu sync.Mutex

	cacheHits    map[string]uint64
	cacheMisses  map[string]uint64
	upstreamErrs map[string]uint64
	writerErrs   map[string]uint64
	bytesServed  map[string]uint64
}

func NewMetrics() *Metrics {
	return &Metrics{
		cacheHits:    make(map[string]uint64),
		cacheMisses:  make(map[string]uint64),
		upstreamErrs: make(map[string]uint64),
		writerErrs:   make(map[string]uint64),
		bytesServed:  make(map[string]uint64),
	}
}

func (m *Metrics) RecordHit(upstream, resource string) {
	m.bump(m.cacheHits, upstream+"|"+resource)
}

func (m *Metrics) RecordMiss(upstream, resource string) {
	m.bump(m.cacheMisses, upstream+"|"+resource)
}

func (m *Metrics) RecordUpstreamError(upstream string) {
	m.bump(m.upstreamErrs, upstream)
}

func (m *Metrics) RecordWriterError(upstream string) {
	m.bump(m.writerErrs, upstream)
}

func (m *Metrics) AddBytesServed(upstream string, n int64) {
	if n <= 0 {
		return
	}
	m.mu.Lock()
	m.bytesServed[upstream] += uint64(n)
	m.mu.Unlock()
}

func (m *Metrics) bump(counter map[string]uint64, key string) {
	m.mu.Lock()
	counter[key]++
	m.mu.Unlock()
}

func (m *Metrics) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Mirror-Timestamp", strconv.FormatInt(time.Now().Unix(), 10))

		m.mu.Lock()
		defer m.mu.Unlock()

		writeCounterPair(w, "aocr_mirror_cache_total", "Cache outcomes by upstream and resource (manifests|blobs).", m.cacheHits, "hit")
		writeCounterPair(w, "aocr_mirror_cache_total", "", m.cacheMisses, "miss")

		writeUpstreamCounter(w, "aocr_mirror_upstream_errors_total", "Errors talking to upstream registries.", m.upstreamErrs)
		writeUpstreamCounter(w, "aocr_mirror_writer_errors_total", "Errors talking to the writer sidecar.", m.writerErrs)
		writeUpstreamCounter(w, "aocr_mirror_bytes_served_total", "Bytes streamed back to clients by upstream.", m.bytesServed)
	})
}

func writeCounterPair(w http.ResponseWriter, name, help string, counters map[string]uint64, outcome string) {
	if help != "" {
		w.Write([]byte("# HELP " + name + " " + help + "\n"))
		w.Write([]byte("# TYPE " + name + " counter\n"))
	}
	for key, value := range counters {
		upstream, resource := splitTwo(key, '|')
		w.Write([]byte(name + `{upstream="` + escapeLabel(upstream) + `",resource="` + escapeLabel(resource) + `",outcome="` + outcome + `"} ` + strconv.FormatUint(value, 10) + "\n"))
	}
}

func writeUpstreamCounter(w http.ResponseWriter, name, help string, counters map[string]uint64) {
	w.Write([]byte("# HELP " + name + " " + help + "\n"))
	w.Write([]byte("# TYPE " + name + " counter\n"))
	for upstream, value := range counters {
		w.Write([]byte(name + `{upstream="` + escapeLabel(upstream) + `"} ` + strconv.FormatUint(value, 10) + "\n"))
	}
}

func splitTwo(s string, sep byte) (string, string) {
	for i := 0; i < len(s); i++ {
		if s[i] == sep {
			return s[:i], s[i+1:]
		}
	}
	return s, ""
}

func escapeLabel(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '\\':
			out = append(out, '\\', '\\')
		case '"':
			out = append(out, '\\', '"')
		case '\n':
			out = append(out, '\\', 'n')
		default:
			out = append(out, s[i])
		}
	}
	return string(out)
}
