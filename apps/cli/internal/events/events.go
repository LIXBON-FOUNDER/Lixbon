// Package events lee el Event Log del Core por su API de lectura (GET /events,
// contrato v=1 de docs/core/EVENTOS.md). No abre SQLite ni estado local: el
// único dato local es orch.json, donde el desktop publica puerto y token.
package events

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"lixbon.com/cli/internal/orch"
)

const (
	ContractVersion = 1

	ExitOK          = 0
	ExitInternal    = 1
	ExitUsage       = 2
	ExitAuth        = 3
	ExitVersion     = 4
	ExitNetwork     = 5
	ExitCursor      = 6
	ExitInterrupted = 130

	requestTimeout = 15 * time.Second
	maxBodyBytes   = 32 << 20
)

type Kind int

const (
	KindInternal Kind = iota
	KindUsage
	KindAuth
	KindVersion
	KindNetwork
	KindCursor
	KindCursorAhead
)

type Error struct {
	Kind    Kind
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

func (e *Error) ExitCode() int {
	switch e.Kind {
	case KindUsage:
		return ExitUsage
	case KindAuth:
		return ExitAuth
	case KindVersion:
		return ExitVersion
	case KindNetwork:
		return ExitNetwork
	case KindCursor, KindCursorAhead:
		return ExitCursor
	default:
		return ExitInternal
	}
}

func newError(kind Kind, code, format string, args ...any) *Error {
	return &Error{Kind: kind, Code: code, Message: fmt.Sprintf(format, args...)}
}

// Filter names are the closed list of the Core; `cursor` is sent separately.
var filterNames = []string{"limit", "project", "run", "entity_kind", "entity_id", "kind", "kind_prefix", "class"}

func IsParam(name string) bool {
	for _, n := range filterNames {
		if n == name {
			return true
		}
	}
	return false
}

type Query struct {
	Cursor int64
	Params map[string]string
}

func (q Query) values() url.Values {
	v := url.Values{"cursor": {strconv.FormatInt(q.Cursor, 10)}}
	for name, value := range q.Params {
		v.Set(name, value)
	}
	return v
}

type Page struct {
	Data       json.RawMessage
	Events     []json.RawMessage
	Seqs       []int64
	NextCursor int64
	HasMore    bool
	HeadSeq    int64
}

type Client struct {
	Dir    string
	TaskID string
	HTTP   *http.Client
}

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: requestTimeout}
}

func (c *Client) Fetch(ctx context.Context, q Query) (*Page, error) {
	endpoint, err := orch.ReadEndpoint(c.Dir)
	if err != nil {
		return nil, newError(KindNetwork, "network", "%v", err)
	}
	target := url.URL{Scheme: "http", Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(endpoint.Port)), Path: "/events", RawQuery: q.values().Encode()}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, newError(KindInternal, "internal", "no se pudo preparar la petición: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+endpoint.Token)
	req.Header.Set("Accept", "application/json")
	if c.TaskID != "" {
		req.Header.Set("X-Lixbon-Caller", c.TaskID)
	}
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return nil, c.transportError(ctx, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return nil, c.transportError(ctx, err)
	}
	return c.parse(resp.StatusCode, body, q.Cursor)
}

func (c *Client) transportError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		err = urlErr.Err
	}
	return newError(KindNetwork, "network", "no se pudo hablar con Lixbon Desktop: %v", err)
}

type apiFailure struct {
	Code  string `json:"code"`
	Error string `json:"error"`
}

func (c *Client) parse(status int, body []byte, cursor int64) (*Page, error) {
	if status != http.StatusOK {
		return nil, c.failure(status, body)
	}
	var envelope struct {
		OK   bool            `json:"ok"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil || !envelope.OK || len(envelope.Data) == 0 {
		return nil, newError(KindVersion, "bad_response", "respuesta inválida del Core en /events (no es el contrato v=%d)", ContractVersion)
	}
	var doc struct {
		V          int               `json:"v"`
		Events     []json.RawMessage `json:"events"`
		NextCursor *int64            `json:"next_cursor"`
		HasMore    bool              `json:"has_more"`
		HeadSeq    *int64            `json:"head_seq"`
	}
	if err := json.Unmarshal(envelope.Data, &doc); err != nil {
		return nil, newError(KindVersion, "bad_response", "respuesta inválida del Core en /events: %v", err)
	}
	if doc.V != ContractVersion {
		return nil, newError(KindVersion, "version", "el Core responde con v=%d y este CLI solo entiende v=%d: actualiza lixbon o Lixbon Desktop", doc.V, ContractVersion)
	}
	if doc.NextCursor == nil || doc.HeadSeq == nil {
		return nil, newError(KindVersion, "contract", "contrato roto: falta next_cursor o head_seq")
	}
	page := &Page{Data: envelope.Data, Events: doc.Events, NextCursor: *doc.NextCursor, HasMore: doc.HasMore, HeadSeq: *doc.HeadSeq}
	if err := page.validate(cursor); err != nil {
		return nil, err
	}
	return page, nil
}

func (p *Page) validate(cursor int64) error {
	last := int64(0)
	for i, raw := range p.Events {
		var head struct {
			Seq *int64 `json:"seq"`
		}
		if err := json.Unmarshal(raw, &head); err != nil || head.Seq == nil || *head.Seq < 1 {
			return newError(KindVersion, "contract", "contrato roto: el evento %d no tiene un seq entero positivo", i)
		}
		if i > 0 && *head.Seq <= last {
			return newError(KindVersion, "contract", "contrato roto: seq no estrictamente creciente (%d tras %d)", *head.Seq, last)
		}
		last = *head.Seq
		p.Seqs = append(p.Seqs, last)
	}
	switch {
	case p.HasMore && len(p.Events) == 0:
		return newError(KindVersion, "contract", "contrato roto: has_more=true sin eventos en la página")
	case p.NextCursor < cursor:
		return newError(KindVersion, "contract", "contrato roto: next_cursor (%d) anterior al cursor pedido (%d)", p.NextCursor, cursor)
	case p.NextCursor < last:
		return newError(KindVersion, "contract", "contrato roto: next_cursor (%d) anterior al último seq (%d)", p.NextCursor, last)
	}
	return nil
}

func (c *Client) failure(status int, body []byte) error {
	var f apiFailure
	_ = json.Unmarshal(bytes.TrimSpace(body), &f)
	message := strings.TrimSpace(f.Error)
	if message == "" {
		message = fmt.Sprintf("el Core respondió HTTP %d", status)
	}
	switch {
	case status == http.StatusNotFound || status == http.StatusMethodNotAllowed:
		return newError(KindVersion, "no_events_api", "este Lixbon Desktop no ofrece GET /events (HTTP %d): actualiza Lixbon Desktop", status)
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return newError(KindAuth, orDefault(f.Code, "forbidden"), "%s", message)
	case f.Code == "invalid_cursor":
		return newError(KindCursor, f.Code, "%s", message)
	case f.Code == "cursor_ahead":
		return newError(KindCursorAhead, f.Code, "%s", message)
	case f.Code == "invalid_limit" || f.Code == "invalid_filter":
		return newError(KindUsage, f.Code, "%s", message)
	case f.Code == "":
		return newError(KindVersion, "bad_response", "respuesta inválida del Core en /events: %s", message)
	default:
		return newError(KindInternal, f.Code, "%s", message)
	}
}

func orDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

// ParseCursor acepta solo el entero decimal que define el Core: sin signo, espacios ni decimales.
func ParseCursor(text string) (int64, error) {
	if text == "" || strings.TrimLeft(text, "0123456789") != "" {
		return 0, newError(KindCursor, "invalid_cursor", "el cursor debe ser un entero decimal >= 0 (recibido %q)", text)
	}
	n, err := strconv.ParseInt(text, 10, 64)
	if err != nil {
		return 0, newError(KindCursor, "invalid_cursor", "el cursor %q está fuera de rango", text)
	}
	return n, nil
}
