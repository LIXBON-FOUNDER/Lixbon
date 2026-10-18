package toolspec

import (
	"slices"
	"testing"
)

func TestCatalogIsConsistent(t *testing.T) {
	if got := len(Names()); got != 33 {
		t.Fatalf("herramientas: %d, esperaba 33", got)
	}
	schemaNames := map[string]bool{}
	for _, schema := range Schemas() {
		fn := schema["function"].(map[string]any)
		schemaNames[fn["name"].(string)] = true
	}
	for _, name := range Names() {
		if !schemaNames[name] {
			t.Errorf("%s sin schema", name)
		}
		if IsReadOnly(name) && IsMutating(name) {
			t.Errorf("%s es de solo lectura y mutante a la vez", name)
		}
	}
	if len(schemaNames) != 33 {
		t.Errorf("schemas distintos: %d", len(schemaNames))
	}
}

func TestEditToolsAreMutating(t *testing.T) {
	for _, name := range []string{"write_file", "edit_file", "multi_edit", "insert_at_line", "append_file"} {
		if !IsEdit(name) || !IsMutating(name) {
			t.Errorf("%s debe ser de edición y mutante", name)
		}
	}
	if IsMutating("run_command") || IsReadOnly("run_command") {
		t.Error("run_command tiene aprobación propia: ni solo lectura ni mutante")
	}
}

func TestArgKeysOrder(t *testing.T) {
	if got := ArgKeys("edit_file"); !slices.Equal(got, []string{"path", "old_text", "new_text", "all"}) {
		t.Fatalf("edit_file: %v", got)
	}
	if ArgKeys("multi_edit") != nil {
		t.Fatal("multi_edit no se repara por esquema")
	}
}

func TestBrowserTools(t *testing.T) {
	for _, name := range []string{"browser_click", "browser_type", "browser_press_key", "browser_navigate", "browser_tabs", "browser_back"} {
		if !IsBrowser(name) || IsReadOnly(name) || IsMutating(name) {
			t.Errorf("%s tiene aprobación propia por sitio: ni solo lectura ni mutante", name)
		}
	}
	if !IsReadOnly("browser_snapshot") || !IsBrowser("browser_snapshot") || IsBrowser("browser_fake") {
		t.Error("browser_snapshot es de solo lectura")
	}
	if got := ArgKeys("browser_type"); !slices.Equal(got, []string{"ref", "text", "submit", "clear"}) {
		t.Fatalf("browser_type: %v", got)
	}
}
