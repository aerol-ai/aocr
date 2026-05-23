package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// Writer is a thin client for the Distribution v2 push protocol against the
// local writer sidecar. Manifests are PUT in one shot; blobs are uploaded via
// the monolithic-upload variant (POST init -> PATCH bytes -> PUT digest), which
// is the simplest interoperable shape and avoids juggling chunk offsets.
type Writer struct {
	baseURL  string
	username string
	password string
	client   *http.Client
}

func NewWriter(cfg *Config, client *http.Client) *Writer {
	return &Writer{
		baseURL:  cfg.WriterAddr,
		username: cfg.WriterUsername,
		password: cfg.WriterPassword,
		client:   client,
	}
}

func (w *Writer) auth(req *http.Request) {
	if w.username != "" {
		req.SetBasicAuth(w.username, w.password)
	}
}

// PutManifest writes a manifest to `<storage>` under reference `ref` (which may
// be a tag or a digest). `contentType` is the manifest media type.
func (w *Writer) PutManifest(ctx context.Context, storage, ref, contentType string, body []byte) error {
	target := fmt.Sprintf("%s/v2/%s/manifests/%s", w.baseURL, storage, ref)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, target, strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", contentType)
	w.auth(req)
	resp, err := w.client.Do(req)
	if err != nil {
		return fmt.Errorf("writer: manifest PUT: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		return fmt.Errorf("writer: manifest PUT %s returned %d: %s", target, resp.StatusCode, string(msg))
	}
	return nil
}

// UploadBlob streams `body` to the writer sidecar as a blob with the supplied
// `digest` (e.g. "sha256:..."). Content-Length is required by the upload
// protocol when finalizing, so the caller must pass `size`.
func (w *Writer) UploadBlob(ctx context.Context, storage, digest string, size int64, body io.Reader) error {
	initURL := fmt.Sprintf("%s/v2/%s/blobs/uploads/", w.baseURL, storage)
	initReq, err := http.NewRequestWithContext(ctx, http.MethodPost, initURL, nil)
	if err != nil {
		return err
	}
	w.auth(initReq)
	initResp, err := w.client.Do(initReq)
	if err != nil {
		return fmt.Errorf("writer: upload init: %w", err)
	}
	defer initResp.Body.Close()
	if initResp.StatusCode != http.StatusAccepted {
		msg, _ := io.ReadAll(io.LimitReader(initResp.Body, 4<<10))
		return fmt.Errorf("writer: upload init returned %d: %s", initResp.StatusCode, string(msg))
	}
	location := initResp.Header.Get("Location")
	if location == "" {
		return fmt.Errorf("writer: upload init missing Location header")
	}
	location = w.absoluteLocation(location)

	patchReq, err := http.NewRequestWithContext(ctx, http.MethodPatch, location, body)
	if err != nil {
		return err
	}
	patchReq.ContentLength = size
	patchReq.Header.Set("Content-Type", "application/octet-stream")
	patchReq.Header.Set("Content-Range", fmt.Sprintf("0-%d", size-1))
	w.auth(patchReq)
	patchResp, err := w.client.Do(patchReq)
	if err != nil {
		return fmt.Errorf("writer: upload patch: %w", err)
	}
	defer patchResp.Body.Close()
	if patchResp.StatusCode != http.StatusAccepted && patchResp.StatusCode != http.StatusCreated {
		msg, _ := io.ReadAll(io.LimitReader(patchResp.Body, 4<<10))
		return fmt.Errorf("writer: upload patch returned %d: %s", patchResp.StatusCode, string(msg))
	}
	patchLocation := patchResp.Header.Get("Location")
	if patchLocation != "" {
		location = w.absoluteLocation(patchLocation)
	}

	putURL := appendDigest(location, digest)
	putReq, err := http.NewRequestWithContext(ctx, http.MethodPut, putURL, nil)
	if err != nil {
		return err
	}
	putReq.Header.Set("Content-Length", "0")
	w.auth(putReq)
	putResp, err := w.client.Do(putReq)
	if err != nil {
		return fmt.Errorf("writer: upload finalize: %w", err)
	}
	defer putResp.Body.Close()
	if putResp.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(putResp.Body, 4<<10))
		return fmt.Errorf("writer: upload finalize %s returned %d: %s", putURL, putResp.StatusCode, string(msg))
	}
	return nil
}

// HeadBlob returns (size, true, nil) if the writer sidecar already stores the
// blob; (0, false, nil) if it does not; or (_, _, err) on a transport error.
func (w *Writer) HeadBlob(ctx context.Context, storage, digest string) (int64, bool, error) {
	target := fmt.Sprintf("%s/v2/%s/blobs/%s", w.baseURL, storage, digest)
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, target, nil)
	if err != nil {
		return 0, false, err
	}
	w.auth(req)
	resp, err := w.client.Do(req)
	if err != nil {
		return 0, false, fmt.Errorf("writer: blob HEAD: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return 0, false, nil
	}
	if resp.StatusCode != http.StatusOK {
		return 0, false, fmt.Errorf("writer: blob HEAD %s returned %d", target, resp.StatusCode)
	}
	return resp.ContentLength, true, nil
}

// HeadManifest returns (digest, contentType, true) if the writer sidecar
// already stores the manifest under the supplied reference.
func (w *Writer) HeadManifest(ctx context.Context, storage, ref string) (digest, contentType string, present bool, err error) {
	target := fmt.Sprintf("%s/v2/%s/manifests/%s", w.baseURL, storage, ref)
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, target, nil)
	if err != nil {
		return "", "", false, err
	}
	req.Header.Set("Accept", manifestAcceptHeader)
	w.auth(req)
	resp, err := w.client.Do(req)
	if err != nil {
		return "", "", false, fmt.Errorf("writer: manifest HEAD: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return "", "", false, nil
	}
	if resp.StatusCode != http.StatusOK {
		return "", "", false, fmt.Errorf("writer: manifest HEAD %s returned %d", target, resp.StatusCode)
	}
	return resp.Header.Get("Docker-Content-Digest"), resp.Header.Get("Content-Type"), true, nil
}

func (w *Writer) absoluteLocation(location string) string {
	if strings.HasPrefix(location, "http://") || strings.HasPrefix(location, "https://") {
		return location
	}
	parsed, err := url.Parse(location)
	if err != nil {
		return w.baseURL + location
	}
	if parsed.IsAbs() {
		return parsed.String()
	}
	if strings.HasPrefix(parsed.Path, "/") {
		return w.baseURL + parsed.String()
	}
	return w.baseURL + "/" + parsed.String()
}

func appendDigest(location, digest string) string {
	if strings.Contains(location, "?") {
		return location + "&digest=" + url.QueryEscape(digest)
	}
	return location + "?digest=" + url.QueryEscape(digest)
}
