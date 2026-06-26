package main

import (
	"testing"
)

func TestLoadConfigDefaults(t *testing.T) {
	t.Setenv("MIRROR_WRITER_ADDR", "http://writer:5050")
	t.Setenv("MIRROR_LISTEN_ADDR", "")
	t.Setenv("MIRROR_TOKEN_CACHE_TTL_SECONDS", "")

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.ListenAddr != ":5100" {
		t.Fatalf("ListenAddr = %q", cfg.ListenAddr)
	}
	if cfg.WriterAddr != "http://writer:5050" {
		t.Fatalf("WriterAddr = %q", cfg.WriterAddr)
	}
	if cfg.TokenCacheTTLSeconds != 300 {
		t.Fatalf("TokenCacheTTLSeconds = %d", cfg.TokenCacheTTLSeconds)
	}
	if cfg.UserAgent != "aocr-mirror/0.1" {
		t.Fatalf("UserAgent = %q", cfg.UserAgent)
	}
}

func TestLoadConfigCustomValues(t *testing.T) {
	t.Setenv("MIRROR_WRITER_ADDR", "http://writer:5050/")
	t.Setenv("MIRROR_LISTEN_ADDR", ":7777")
	t.Setenv("MIRROR_USER_AGENT", "test-agent")
	t.Setenv("MIRROR_TOKEN_CACHE_TTL_SECONDS", "120")
	t.Setenv("MIRROR_METRICS_ADDR", ":9100")

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.ListenAddr != ":7777" || cfg.WriterAddr != "http://writer:5050" || cfg.UserAgent != "test-agent" {
		t.Fatalf("unexpected cfg: %+v", cfg)
	}
	if cfg.TokenCacheTTLSeconds != 120 || cfg.MetricsAddr != ":9100" {
		t.Fatalf("TokenCacheTTLSeconds/MetricsAddr = %d / %q", cfg.TokenCacheTTLSeconds, cfg.MetricsAddr)
	}
}

func TestLoadConfigUsesDefaultWriterAddr(t *testing.T) {
	t.Setenv("MIRROR_WRITER_ADDR", "")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.WriterAddr != "http://127.0.0.1:5050" {
		t.Fatalf("WriterAddr = %q", cfg.WriterAddr)
	}
}

func TestEnvIntInvalid(t *testing.T) {
	if got := envInt("MIRROR_TEST_INT", 42); got != 42 {
		t.Fatalf("fallback = %d", got)
	}
	t.Setenv("MIRROR_TEST_INT", "not-a-number")
	if got := envInt("MIRROR_TEST_INT", 42); got != 42 {
		t.Fatalf("invalid int fallback = %d", got)
	}
	t.Setenv("MIRROR_TEST_INT", "-5")
	if got := envInt("MIRROR_TEST_INT", 42); got != 42 {
		t.Fatalf("non-positive int fallback = %d", got)
	}
}

func TestEnvDefault(t *testing.T) {
	if got := envDefault("MIRROR_TEST_DEFAULT", "fallback"); got != "fallback" {
		t.Fatalf("default = %q", got)
	}
	t.Setenv("MIRROR_TEST_DEFAULT", "  custom  ")
	if got := envDefault("MIRROR_TEST_DEFAULT", "fallback"); got != "custom" {
		t.Fatalf("trimmed = %q", got)
	}
}
