package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Config is the runtime configuration of the mirror proxy. All values are
// derived from environment variables so the proxy can be deployed as a vanilla
// Kubernetes Deployment without touching its on-disk filesystem.
type Config struct {
	// ListenAddr is the address the proxy serves on (e.g. ":5100").
	ListenAddr string

	// WriterAddr is the base URL of the local Distribution writer sidecar
	// (e.g. "http://127.0.0.1:5050"). The proxy uploads cached content here.
	WriterAddr string

	// WriterUsername / WriterPassword are htpasswd credentials for the writer
	// sidecar (Distribution's "silly" or "htpasswd" auth).
	WriterUsername string
	WriterPassword string

	// UserAgent is sent in upstream and writer requests.
	UserAgent string

	// MetricsAddr is the address the metrics endpoint serves on (e.g. ":9100").
	// When empty, metrics are not exposed on a separate listener and instead
	// are mounted on the main listener at /metrics.
	MetricsAddr string

	// TokenCacheTTLSeconds is how long upstream bearer tokens are cached.
	TokenCacheTTLSeconds int
}

func LoadConfig() (*Config, error) {
	cfg := &Config{
		ListenAddr:           envDefault("MIRROR_LISTEN_ADDR", ":5100"),
		WriterAddr:           envDefault("MIRROR_WRITER_ADDR", "http://127.0.0.1:5050"),
		WriterUsername:       os.Getenv("MIRROR_WRITER_USERNAME"),
		WriterPassword:       os.Getenv("MIRROR_WRITER_PASSWORD"),
		UserAgent:            envDefault("MIRROR_USER_AGENT", "aocr-mirror/0.1"),
		MetricsAddr:          os.Getenv("MIRROR_METRICS_ADDR"),
		TokenCacheTTLSeconds: envInt("MIRROR_TOKEN_CACHE_TTL_SECONDS", 300),
	}

	cfg.WriterAddr = strings.TrimRight(cfg.WriterAddr, "/")
	if cfg.WriterAddr == "" {
		return nil, fmt.Errorf("MIRROR_WRITER_ADDR must be set")
	}

	return cfg, nil
}

func envDefault(name, fallback string) string {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return fallback
	}
	return v
}

func envInt(name string, fallback int) int {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(v)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}
