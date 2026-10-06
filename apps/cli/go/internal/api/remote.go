package api

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"time"
)

const remoteStreamIdle = 90 * time.Second

type RemoteSession struct {
	ID       string
	ShareURL string
}

// RemoteCreate abre una sesión de control remoto en el gateway (el host).
func (c *Client) RemoteCreate(ctx context.Context, source, title, machine string) (RemoteSession, error) {
	var data struct {
		Session struct {
			ID string `json:"id"`
		} `json:"session"`
		ShareURL string `json:"share_url"`
	}
	payload := map[string]any{"source": source, "title": title, "machine": machine}
	err := c.doJSON(ctx, http.MethodPost, c.Server+"/api/remote/sessions", payload, 20*time.Second, true, &data)
	return RemoteSession{ID: data.Session.ID, ShareURL: data.ShareURL}, err
}

// RemoteEvents publica un lote de eventos del transcript.
func (c *Client) RemoteEvents(ctx context.Context, sessionID string, events []map[string]any) error {
	return c.doJSON(ctx, http.MethodPost, c.Server+"/api/remote/sessions/"+sessionID+"/events",
		map[string]any{"events": events}, 20*time.Second, true, nil)
}

func (c *Client) RemoteEnd(ctx context.Context, sessionID string) error {
	return c.doJSON(ctx, http.MethodDelete, c.Server+"/api/remote/sessions/"+sessionID, nil, 20*time.Second, true, nil)
}

// RemoteQR devuelve el QR del enlace como texto unicode, generado por el gateway.
func (c *Client) RemoteQR(ctx context.Context, data string) (string, error) {
	if c.Generic {
		return "", errNotGateway
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	resp, err := c.open(ctx, http.MethodGet, c.Server+"/api/remote/qr?fmt=txt&data="+url.QueryEscape(data), nil, true)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	return string(raw), err
}

type commandStream struct {
	body   io.ReadCloser
	idle   *idleReader
	cancel context.CancelFunc
}

func (s *commandStream) Read(p []byte) (int, error) { return s.idle.Read(p) }

func (s *commandStream) Close() error {
	s.idle.stop()
	s.cancel()
	return s.body.Close()
}

// RemoteCommands abre el SSE de larga duración con los comandos del móvil o la
// web. El gateway manda keepalives cada 15 s: sin tráfico durante 90 s la
// conexión se da por perdida y el llamador reconecta.
func (c *Client) RemoteCommands(ctx context.Context, sessionID string) (io.ReadCloser, error) {
	if c.Generic {
		return nil, errNotGateway
	}
	ctx, cancel := context.WithCancel(ctx)
	idle := newIdleReader(cancel, remoteStreamIdle)
	resp, err := c.open(ctx, http.MethodGet, c.Server+"/api/remote/sessions/"+sessionID+"/commands", nil, true)
	if err != nil {
		idle.stop()
		cancel()
		return nil, err
	}
	idle.body = resp.Body
	return &commandStream{body: resp.Body, idle: idle, cancel: cancel}, nil
}
