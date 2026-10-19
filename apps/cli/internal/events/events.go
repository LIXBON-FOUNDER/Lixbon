// Package events lee el Event Log del Core por su API de lectura (GET /events,
// contrato v=1 de docs/core/EVENTOS.md). Nunca abre SQLite ni el estado del Core.
// orch.json solo aporta dirección y versión; la credencial de agente proviene de
// LXO_CLIENT_TOKEN y pasa por /handshake antes de /events. Lo único que escribe
// es el último cursor confirmado de un seguimiento (ver cursor.go).
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
	Dir        string
	TaskID     string
	HTTP       *http.Client
	agentToken string
}

// NewAgentClient crea un cliente con la identidad de agente que entrega el
// orquestador en el entorno. El token nunca se obtiene de orch.json.
func NewAgentClient(dir, taskID, token string) *Client {
	return &Client{Dir: dir, TaskID: taskID, agentToken: token}
}

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: requestTimeout}
}

func (c *Client) Fetch(ctx context.Context, q Query) (*Page, error) {
	if strings.TrimSpace(c.TaskID) == "" || strings.TrimSpace(c.agentToken) == "" {
		return nil, newError(KindAuth, "missing_agent_identity", "events requiere LXO_TASK_ID y LXO_CLIENT_TOKEN para autenticarse como agente")
	}
	endpoint, err := orch.ReadEndpoint(c.Dir)
	if err != nil {
		return nil, newError(KindNetwork, "network", "%v", err)
	}
	handshake, err := c.request(ctx, endpoint, "/handshake", "")
	if err != nil {
		return nil, err
	}
	if err := c.validateHandshake(handshake.status, handshake.body, endpoint.Version); err != nil {
		return nil, err
	}
	pageResponse, err := c.request(ctx, endpoint, "/events", q.values().Encode())
	if err != nil {
		return nil, err
	}
	return c.parse(pageResponse.status, pageResponse.body, q.Cursor)
}

type response struct {
	status int
	body   []byte
}

func (c *Client) request(ctx context.Context, endpoint orch.Endpoint, path, rawQuery string) (response, error) {
	target := url.URL{Scheme: "http", Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(endpoint.Port)), Path: path, RawQuery: rawQuery}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return response{}, newError(KindInternal, "internal", "no se pudo preparar la petición: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.agentToken)
	req.Header.Set("Accept", "application/json")
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return response{}, c.transportError(ctx, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return response{}, c.transportError(ctx, err)
	}
	return response{status: resp.StatusCode, body: body}, nil
}

func (c *Client) transportError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		err = urlErr.Err
	}
	return newError(KindNetwork, "network", "no se pudo hablar con Lixbon Desktop: %v", redactSecret(err.Error(), c.agentToken))
}

func (c *Client) validateHandshake(status int, body []byte, expectedVersion string) error {
	if status != http.StatusOK {
		return c.failure(status, body, "/handshake")
	}
	var envelope struct {
		OK   bool            `json:"ok"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil || !envelope.OK || len(envelope.Data) == 0 {
		return newError(KindVersion, "bad_handshake", "respuesta inválida del Core en /handshake")
	}
	var doc struct {
		CoreVersion     *string  `json:"core_version"`
		ProtocolVersion *int     `json:"protocol_version"`
		SchemaVersion   *int     `json:"schema_version"`
		Capabilities    []string `json:"capabilities"`
		ClientID        *string  `json:"client_id"`
	}
	if err := json.Unmarshal(envelope.Data, &doc); err != nil {
		return newError(KindVersion, "bad_handshake", "respuesta inválida del Core en /handshake")
	}
	if doc.CoreVersion == nil || *doc.CoreVersion != expectedVersion {
		got := "ausente"
		if doc.CoreVersion != nil {
			got = *doc.CoreVersion
		}
		return newError(KindVersion, "version_mismatch", "versión de Lixbon Desktop incompatible (handshake %q, orch.json %q): actualiza Lixbon Desktop o lixbon", got, expectedVersion)
	}
	if doc.ProtocolVersion == nil || *doc.ProtocolVersion != 1 || doc.SchemaVersion == nil || *doc.SchemaVersion < 6 ||
		doc.ClientID == nil || strings.TrimSpace(*doc.ClientID) == "" ||
		!contains(doc.Capabilities, "rpc") || !contains(doc.Capabilities, "events.read") {
		return newError(KindVersion, "version_mismatch", "protocolo o capacidades del Core incompatibles en /handshake")
	}
	return nil
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

type apiFailure struct {
	Code  string `json:"code"`
	Error string `json:"error"`
}

func (c *Client) parse(status int, body []byte, cursor int64) (*Page, error) {
	if status != http.StatusOK {
		return nil, c.failure(status, body, "/events")
	}
	var envelope struct {
		OK   bool            `json:"ok"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil || !envelope.OK || len(envelope.Data) == 0 {
		return nil, newError(KindVersion, "bad_response", "respuesta inválida del Core en /events (no es el contrato v=%d)", ContractVersion)
	}
	var doc struct {
		V          int             `json:"v"`
		Events     json.RawMessage `json:"events"`
		NextCursor *int64          `json:"next_cursor"`
		HasMore    *bool           `json:"has_more"`
		HeadSeq    *int64          `json:"head_seq"`
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
	if doc.HasMore == nil {
		return nil, newError(KindVersion, "contract", "contrato roto: falta has_more o no es un booleano")
	}
	var list []json.RawMessage
	if bytes.HasPrefix(bytes.TrimSpace(doc.Events), []byte("[")) {
		_ = json.Unmarshal(doc.Events, &list)
	}
	if list == nil {
		return nil, newError(KindVersion, "contract", "contrato roto: falta events o no es un array")
	}
	page := &Page{Data: envelope.Data, Events: list, NextCursor: *doc.NextCursor, HasMore: *doc.HasMore, HeadSeq: *doc.HeadSeq}
	if err := page.validate(cursor); err != nil {
		return nil, err
	}
	return page, nil
}

func (p *Page) validate(cursor int64) error {
	last := cursor
	for i, raw := range p.Events {
		var head struct {
			Seq *int64 `json:"seq"`
		}
		if err := json.Unmarshal(raw, &head); err != nil || head.Seq == nil || *head.Seq < 1 {
			return newError(KindVersion, "contract", "contrato roto: el evento %d no tiene un seq entero positivo", i)
		}
		if *head.Seq <= last {
			return newError(KindVersion, "contract", "contrato roto: seq %d no es estrictamente creciente ni posterior al cursor %d (último visto %d)", *head.Seq, cursor, last)
		}
		if *head.Seq > p.HeadSeq {
			return newError(KindVersion, "contract", "contrato roto: seq %d supera head_seq %d", *head.Seq, p.HeadSeq)
		}
		last = *head.Seq
		p.Seqs = append(p.Seqs, last)
	}
	switch {
	case p.NextCursor < cursor:
		return newError(KindVersion, "contract", "contrato roto: next_cursor (%d) anterior al cursor pedido (%d); el Core debía responder cursor_ahead", p.NextCursor, cursor)
	case p.HasMore && len(p.Events) == 0:
		return newError(KindVersion, "contract", "contrato roto: has_more=true sin eventos en la página")
	case p.HasMore && p.NextCursor != last:
		return newError(KindVersion, "contract", "contrato roto: con has_more=true next_cursor (%d) debe ser el último seq (%d)", p.NextCursor, last)
	case !p.HasMore && p.NextCursor != p.HeadSeq:
		return newError(KindVersion, "contract", "contrato roto: con has_more=false next_cursor (%d) debe ser head_seq (%d)", p.NextCursor, p.HeadSeq)
	}
	return nil
}

func (c *Client) failure(status int, body []byte, path string) error {
	var f apiFailure
	_ = json.Unmarshal(bytes.TrimSpace(body), &f)
	message := strings.TrimSpace(redactSecret(f.Error, c.agentToken))
	code := redactSecret(f.Code, c.agentToken)
	if message == "" {
		message = fmt.Sprintf("el Core respondió HTTP %d", status)
	}
	switch {
	case status == http.StatusNotFound || status == http.StatusMethodNotAllowed || status == http.StatusUpgradeRequired || code == "version_mismatch":
		return newError(KindVersion, "version_mismatch", "este Lixbon Desktop no ofrece un %s compatible (HTTP %d): actualiza Lixbon Desktop", path, status)
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return newError(KindAuth, orDefault(code, "forbidden"), "%s", message)
	case code == "invalid_cursor":
		return newError(KindCursor, code, "%s", message)
	case code == "cursor_ahead":
		return newError(KindCursorAhead, code, "%s", message)
	case code == "invalid_limit" || code == "invalid_filter":
		return newError(KindUsage, code, "%s", message)
	case code == "core_unavailable":
		return newError(KindNetwork, code, "%s", message)
	case code == "":
		return newError(KindVersion, "bad_response", "respuesta inválida del Core en %s: %s", path, message)
	default:
		return newError(KindInternal, code, "%s", message)
	}
}

func redactSecret(text, secret string) string {
	if secret == "" {
		return text
	}
	return strings.ReplaceAll(text, secret, "[credencial oculta]")
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
