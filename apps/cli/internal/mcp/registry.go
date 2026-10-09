package mcp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"
)

// maxFunctionName es el límite de nombre de función de las APIs compatibles
// con OpenAI.
const maxFunctionName = 64

var nonIdent = regexp.MustCompile(`[^A-Za-z0-9_]`)

func slug(text string) string {
	if s := strings.Trim(nonIdent.ReplaceAllString(text, "_"), "_"); s != "" {
		return s
	}
	return "x"
}

type toolRef struct {
	server *Server
	tool   string
}

// ServerInfo describe un servidor para /mcp.
type ServerInfo struct {
	Name   string
	Target string
	Tools  int
	Err    string
	// Starting indica que el arranque aún no terminó.
	Starting bool
}

// ToolInfo es una herramienta tal como la ve el modelo.
type ToolInfo struct {
	Name        string
	Description string
}

// Registry reúne los servidores MCP y expone sus herramientas al agente.
// Implementa agent.MCPClient. Los servidores arrancan en segundo plano y sus
// herramientas aparecen según responden.
type Registry struct {
	ctx    context.Context
	cancel context.CancelFunc

	servers []*Server
	ready   chan struct{}

	mu      sync.RWMutex
	exposed map[string]toolRef
	schemas []json.RawMessage
	infos   []ToolInfo
}

func NewRegistry(specs []Spec) *Registry {
	ctx, cancel := context.WithCancel(context.Background())
	r := &Registry{ctx: ctx, cancel: cancel, ready: make(chan struct{}), exposed: map[string]toolRef{}}
	for _, spec := range specs {
		r.servers = append(r.servers, NewServer(spec))
	}
	return r
}

// Start arranca todos los servidores a la vez y vuelve cuando todos han
// terminado (bien o mal). Un servidor roto no afecta a los demás.
func (r *Registry) Start() {
	defer close(r.ready)
	var wg sync.WaitGroup
	for _, server := range r.servers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = server.Start(r.ctx)
			r.rebuild()
		}()
	}
	wg.Wait()
}

// Wait espera a que termine el arranque o a que acabe ctx; informa de si
// terminó.
func (r *Registry) Wait(ctx context.Context) bool {
	select {
	case <-r.ready:
		return true
	case <-ctx.Done():
		return false
	}
}

func (r *Registry) Servers() []*Server { return r.servers }

// Server devuelve el servidor con ese nombre.
func (r *Registry) Server(name string) (*Server, bool) {
	for _, s := range r.servers {
		if s.Spec.Name == name {
			return s, true
		}
	}
	return nil, false
}

// rebuild recalcula los nombres expuestos de forma determinista: servidores en
// el orden de mcp.json y herramientas en el orden del servidor.
func (r *Registry) rebuild() {
	exposed := map[string]toolRef{}
	var schemas []json.RawMessage
	var infos []ToolInfo
	for _, server := range r.servers {
		if !server.Ready() {
			continue
		}
		for _, tool := range server.Tools() {
			name := uniqueName(exposed, server.Spec.Name, tool.Name)
			exposed[name] = toolRef{server, tool.Name}
			schema, description := toolSchema(name, server.Spec.Name, tool)
			schemas = append(schemas, schema)
			infos = append(infos, ToolInfo{Name: name, Description: description})
		}
	}
	r.mu.Lock()
	r.exposed, r.schemas, r.infos = exposed, schemas, infos
	r.mu.Unlock()
}

// uniqueName construye mcp__<servidor>__<herramienta> dentro del límite de
// longitud; si dos herramientas darían el mismo nombre, añade un sufijo.
func uniqueName(taken map[string]toolRef, server, tool string) string {
	base := fmt.Sprintf("mcp__%s__%s", slug(server), slug(tool))
	for n := 1; ; n++ {
		candidate := base
		if n > 1 {
			candidate = fmt.Sprintf("%s_%d", base, n)
		}
		if len(candidate) > maxFunctionName {
			sum := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%s\x00%d", server, tool, n)))
			candidate = candidate[:maxFunctionName-9] + "_" + hex.EncodeToString(sum[:4])
		}
		if _, used := taken[candidate]; !used {
			return candidate
		}
	}
}

// toolSchema da forma de función a la herramienta. Se conserva el
// inputSchema tal cual (con su orden de propiedades) salvo que le falte
// type, que las APIs exigen.
func toolSchema(exposed, server string, tool Tool) (json.RawMessage, string) {
	description := truncateRunes(fmt.Sprintf("[MCP %s] %s", server, firstNonEmpty(tool.Description, tool.Name)), 1000)
	schema, _ := json.Marshal(map[string]any{
		"type": "function",
		"function": map[string]any{
			"name":        exposed,
			"description": description,
			"parameters":  parametersOf(tool.InputSchema),
		},
	})
	return schema, description
}

func parametersOf(raw json.RawMessage) json.RawMessage {
	empty := json.RawMessage(`{"type":"object","properties":{}}`)
	var fields map[string]json.RawMessage
	if len(raw) == 0 || json.Unmarshal(raw, &fields) != nil || len(fields) == 0 {
		return empty
	}
	if _, ok := fields["type"]; ok {
		return raw
	}
	fields["type"] = json.RawMessage(`"object"`)
	patched, err := json.Marshal(fields)
	if err != nil {
		return empty
	}
	return patched
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// ToolSchemas son las herramientas listas hasta ahora, en formato de función.
func (r *Registry) ToolSchemas() []json.RawMessage {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.schemas
}

func (r *Registry) Tools() []ToolInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.infos
}

func (r *Registry) IsMCPTool(name string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	_, ok := r.exposed[name]
	return ok
}

// Call ejecuta la herramienta; los fallos vuelven como texto «[ERROR] …» para
// que el modelo los vea.
func (r *Registry) Call(ctx context.Context, name string, args map[string]any) string {
	r.mu.RLock()
	ref, ok := r.exposed[name]
	r.mu.RUnlock()
	if !ok {
		return "[ERROR] Herramienta MCP desconocida: " + name
	}
	if !ref.server.Alive() {
		return fmt.Sprintf("[ERROR] El servidor MCP «%s» no está en marcha", ref.server.Spec.Name)
	}
	out, err := ref.server.CallTool(ctx, ref.tool, args)
	if err != nil {
		return "[ERROR] " + err.Error()
	}
	return out
}

// Summary describe cada servidor declarado.
func (r *Registry) Summary() []ServerInfo {
	starting := true
	select {
	case <-r.ready:
		starting = false
	default:
	}
	out := make([]ServerInfo, 0, len(r.servers))
	for _, s := range r.servers {
		info := ServerInfo{Name: s.Spec.Name, Target: s.Spec.Target(), Tools: len(s.Tools()), Err: s.Err()}
		info.Starting = starting && !s.Ready() && info.Err == ""
		out = append(out, info)
	}
	return out
}

// Close cancela los arranques pendientes y cierra todos los servidores a la
// vez; no espera más que el tiempo de gracia de cada uno.
func (r *Registry) Close() {
	r.cancel()
	var wg sync.WaitGroup
	for _, s := range r.servers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.Close()
		}()
	}
	wg.Wait()
}
