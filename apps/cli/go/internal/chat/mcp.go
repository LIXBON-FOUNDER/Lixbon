package chat

import (
	"context"
	"path/filepath"

	"lixbon.com/cli/internal/config"
	"lixbon.com/cli/internal/mcp"
)

const lixbonMCP = "lixbon"

// MCPSpecs son los servidores de mcp.json más el de Lixbon (Visuals), que se
// añade si hay cuenta Lixbon y no se desactivó con "lixbon_mcp": false.
func (c *Chat) MCPSpecs() []mcp.Spec {
	specs := mcp.LoadSpecs(c.Workspace, filepath.Dir(c.ConfigPath))
	if c.Cfg.APIKey == "" || c.Cfg.IsGeneric() || !c.Cfg.ExtraBool("lixbon_mcp", true) {
		return specs
	}
	for _, s := range specs {
		if s.Name == lixbonMCP {
			return specs
		}
	}
	return append(specs, mcp.Spec{
		Name:    lixbonMCP,
		URL:     config.ServerBase(c.Cfg.BaseURL) + "/mcp",
		Headers: map[string]string{"Authorization": "Bearer " + c.Cfg.APIKey},
	})
}

// StartMCP arranca en segundo plano los servidores configurados: el modelo ve
// sus herramientas según responden y el arranque del CLI no espera.
func (c *Chat) StartMCP() {
	specs := c.MCPSpecs()
	if len(specs) == 0 || c.MCP != nil {
		return
	}
	c.MCP = mcp.NewRegistry(specs)
	c.Session.MCP = c.MCP
	go c.MCP.Start()
}

// WaitMCP espera a que terminen de arrancar los servidores (para `--once`,
// donde nadie escribe mientras tanto).
func (c *Chat) WaitMCP(ctx context.Context) {
	if c.MCP != nil {
		c.MCP.Wait(ctx)
	}
}

// StopMCP cierra los servidores MCP y sus procesos.
func (c *Chat) StopMCP() {
	if c.MCP != nil {
		c.MCP.Close()
	}
}
