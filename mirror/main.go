package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	cfg, err := LoadConfig()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	httpClient := &http.Client{Timeout: 5 * time.Minute}
	writer := NewWriter(cfg, httpClient)
	metrics := NewMetrics()
	registry := NewRegistry(
		&DockerHub{}, &GHCR{}, &GCR{}, &Quay{}, &K8sRegistry{},
	)
	proxy := NewProxy(cfg, registry, httpClient, writer, metrics)

	server := &http.Server{
		Addr:    cfg.ListenAddr,
		Handler: proxy.Routes(),
	}

	idleConnsClosed := make(chan struct{})
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("mirror: shutdown signal received")
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			log.Printf("mirror: shutdown: %v", err)
		}
		close(idleConnsClosed)
	}()

	log.Printf("mirror: listening on %s, writer at %s", cfg.ListenAddr, cfg.WriterAddr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("mirror: serve: %v", err)
	}
	<-idleConnsClosed
}
