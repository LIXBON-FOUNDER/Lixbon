package clipboard

import (
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

const (
	cfDIB   = 8
	cfHDROP = 15
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")

	openClipboard           = user32.NewProc("OpenClipboard")
	closeClipboard          = user32.NewProc("CloseClipboard")
	isClipboardFormat       = user32.NewProc("IsClipboardFormatAvailable")
	getClipboardData        = user32.NewProc("GetClipboardData")
	registerClipboardFormat = user32.NewProc("RegisterClipboardFormatW")
	globalLock              = kernel32.NewProc("GlobalLock")
	globalUnlock            = kernel32.NewProc("GlobalUnlock")
	globalSize              = kernel32.NewProc("GlobalSize")
	dragQueryFile           = shell32.NewProc("DragQueryFileW")
)

func available(format uintptr) bool {
	ok, _, _ := isClipboardFormat.Call(format)
	return ok != 0
}

func readHandle(handle uintptr) []byte {
	size, _, _ := globalSize.Call(handle)
	pointer, _, _ := globalLock.Call(handle)
	if pointer == 0 || size == 0 {
		return nil
	}
	defer globalUnlock.Call(handle)
	// El bloque es memoria de Windows, no del GC: la conversión doble evita el
	// aviso de vet sin cambiar nada, porque GlobalLock devuelve una dirección fija.
	memory := *(*unsafe.Pointer)(unsafe.Pointer(&pointer))
	return append([]byte(nil), unsafe.Slice((*byte)(memory), size)...)
}

// copiedImageFile devuelve un archivo de imagen copiado en el Explorador: vale
// igual que un mapa de bits y conserva el formato original.
func copiedImageFile() string {
	if !available(cfHDROP) {
		return ""
	}
	handle, _, _ := getClipboardData.Call(cfHDROP)
	if handle == 0 {
		return ""
	}
	count, _, _ := dragQueryFile.Call(handle, 0xFFFFFFFF, 0, 0)
	for i := uintptr(0); i < count; i++ {
		length, _, _ := dragQueryFile.Call(handle, i, 0, 0)
		buffer := make([]uint16, length+1)
		dragQueryFile.Call(handle, i, uintptr(unsafe.Pointer(&buffer[0])), length+1)
		path := syscall.UTF16ToString(buffer)
		switch strings.ToLower(filepath.Ext(path)) {
		case ".png", ".jpg", ".jpeg", ".webp":
			return path
		}
	}
	return ""
}

type clipboardImage struct {
	file string
	png  []byte
	dib  []byte
}

func readClipboard() (image clipboardImage, opened bool) {
	pngName, _ := syscall.UTF16PtrFromString("PNG")
	pngFormat, _, _ := registerClipboardFormat.Call(uintptr(unsafe.Pointer(pngName)))

	if ok, _, _ := openClipboard.Call(0); ok == 0 {
		return image, false
	}
	defer closeClipboard.Call()

	if image.file = copiedImageFile(); image.file != "" {
		return image, true
	}
	// Muchas apps publican también un PNG ya hecho: usarlo evita decodificar
	// el DIB y conserva la calidad original.
	if pngFormat != 0 && available(pngFormat) {
		handle, _, _ := getClipboardData.Call(pngFormat)
		if data := readHandle(handle); isPNG(data) {
			image.png = data
			return image, true
		}
	}
	if available(cfDIB) {
		handle, _, _ := getClipboardData.Call(cfDIB)
		image.dib = readHandle(handle)
	}
	return image, true
}

func readImage(dir string) (string, string) {
	image, opened := readClipboard()
	switch {
	case !opened:
		return "", "no se pudo abrir el portapapeles"
	case image.file != "":
		return image.file, ""
	case image.png != nil:
		return store(dir, image.png)
	case image.dib != nil:
		data, ok := DIBToPNG(image.dib)
		if !ok {
			return "", "formato de imagen no soportado (usa 24 o 32 bits sin comprimir)"
		}
		return store(dir, data)
	}
	return "", "el portapapeles no tiene ninguna imagen"
}
