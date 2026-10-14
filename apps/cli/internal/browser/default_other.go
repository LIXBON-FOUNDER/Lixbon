//go:build !windows

package browser

import (
	"os/exec"
	"strings"
)

// defaultBrowser pregunta a xdg-settings en Linux; en macOS no hay una forma
// sencilla sin CGO y se sigue el orden de families.
func defaultBrowser() string {
	out, err := exec.Command("xdg-settings", "get", "default-web-browser").Output()
	if err != nil {
		return ""
	}
	name := strings.ToLower(string(out))
	for _, family := range []string{"brave", "chromium", "chrome", "edge"} {
		if strings.Contains(name, family) {
			return family
		}
	}
	return ""
}
