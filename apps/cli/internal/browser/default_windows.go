package browser

import "golang.org/x/sys/windows/registry"

// defaultBrowser lee el ProgId con el que Windows abre los enlaces https.
func defaultBrowser() string {
	k, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice`, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	id, _, err := k.GetStringValue("ProgId")
	if err != nil {
		return ""
	}
	return familyOfProgID(id)
}
