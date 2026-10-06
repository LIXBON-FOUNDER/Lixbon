package documents

import (
	"archive/zip"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"lixbon.com/cli/internal/textutil"
)

const (
	maxDocxXMLBytes = 64 << 20
	noDocxText      = "(el documento no tiene texto)"
)

type node struct {
	name     string
	attrs    map[string]string
	text     string
	children []*node
}

// DocxText devuelve los párrafos de un .docx y, después, sus tablas (una fila
// por línea, celdas separadas por « | »), igual que el CLI Python.
func DocxText(path string) (string, error) {
	archive, err := zip.OpenReader(path)
	if err != nil {
		return "", errors.New("el archivo no es un documento Word válido")
	}
	defer archive.Close()
	body, err := readBody(&archive.Reader)
	if err != nil {
		return "", err
	}

	var parts []string
	for _, child := range body.children {
		if child.name == "p" {
			if text := paragraphText(child); textutil.Strip(text) != "" {
				parts = append(parts, text)
			}
		}
	}
	for _, child := range body.children {
		if child.name != "tbl" {
			continue
		}
		for _, row := range tableRows(child) {
			var cells []string
			for _, cell := range row {
				if text := textutil.Strip(cell); text != "" {
					cells = append(cells, text)
				}
			}
			if len(cells) > 0 {
				parts = append(parts, strings.Join(cells, " | "))
			}
		}
	}
	if len(parts) == 0 {
		return noDocxText, nil
	}
	return strings.Join(parts, "\n"), nil
}

func readBody(archive *zip.Reader) (*node, error) {
	for _, entry := range archive.File {
		if entry.Name != "word/document.xml" {
			continue
		}
		rc, err := entry.Open()
		if err != nil {
			return nil, err
		}
		defer rc.Close()
		root, err := parseXML(io.LimitReader(rc, maxDocxXMLBytes))
		if err != nil {
			return nil, fmt.Errorf("el documento Word está dañado: %v", err)
		}
		for _, document := range root.children {
			for _, child := range document.children {
				if child.name == "body" {
					return child, nil
				}
			}
		}
		return &node{}, nil
	}
	return nil, errors.New("el archivo no es un documento Word válido (falta word/document.xml)")
}

func parseXML(r io.Reader) (*node, error) {
	decoder := xml.NewDecoder(r)
	root := &node{}
	stack := []*node{root}
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			return root, nil
		}
		if err != nil {
			return nil, err
		}
		switch t := token.(type) {
		case xml.StartElement:
			n := &node{name: t.Name.Local, attrs: make(map[string]string, len(t.Attr))}
			for _, a := range t.Attr {
				n.attrs[a.Name.Local] = a.Value
			}
			top := stack[len(stack)-1]
			top.children = append(top.children, n)
			stack = append(stack, n)
		case xml.EndElement:
			stack = stack[:len(stack)-1]
		case xml.CharData:
			stack[len(stack)-1].text += string(t)
		}
	}
}

// paragraphText concatena el texto de las runs del párrafo y de sus hipervínculos.
func paragraphText(p *node) string {
	var sb strings.Builder
	for _, child := range p.children {
		switch child.name {
		case "r":
			sb.WriteString(runText(child))
		case "hyperlink":
			for _, run := range child.children {
				if run.name == "r" {
					sb.WriteString(runText(run))
				}
			}
		}
	}
	return sb.String()
}

func runText(run *node) string {
	var sb strings.Builder
	for _, e := range run.children {
		switch e.name {
		case "t":
			sb.WriteString(e.text)
		case "tab", "ptab":
			sb.WriteByte('\t')
		case "cr":
			sb.WriteByte('\n')
		case "br":
			if kind := e.attrs["type"]; kind == "" || kind == "textWrapping" {
				sb.WriteByte('\n')
			}
		case "noBreakHyphen":
			sb.WriteByte('-')
		}
	}
	return sb.String()
}

func cellText(tc *node) string {
	var paragraphs []string
	for _, child := range tc.children {
		if child.name == "p" {
			paragraphs = append(paragraphs, paragraphText(child))
		}
	}
	return strings.Join(paragraphs, "\n")
}

// tableRows replica Table.rows[i].cells de python-docx: una celda combinada en
// horizontal aparece repetida en cada columna que ocupa y una combinada en
// vertical repite la de arriba.
func tableRows(tbl *node) [][]string {
	columns := 0
	for _, child := range tbl.children {
		if child.name == "tblGrid" {
			for _, col := range child.children {
				if col.name == "gridCol" {
					columns++
				}
			}
		}
	}
	var cells []string
	for _, tr := range tbl.children {
		if tr.name != "tr" {
			continue
		}
		for _, tc := range tr.children {
			if tc.name != "tc" {
				continue
			}
			span, continued := 1, false
			for _, prop := range tc.children {
				if prop.name != "tcPr" {
					continue
				}
				for _, p := range prop.children {
					switch p.name {
					case "gridSpan":
						if n, err := strconv.Atoi(p.attrs["val"]); err == nil && n > 1 {
							span = n
						}
					case "vMerge":
						continued = p.attrs["val"] == "" || p.attrs["val"] == "continue"
					}
				}
			}
			text := cellText(tc)
			for i := 0; i < span; i++ {
				switch {
				case continued && len(cells) >= columns:
					cells = append(cells, cells[len(cells)-columns])
				case i > 0:
					cells = append(cells, cells[len(cells)-1])
				default:
					cells = append(cells, text)
				}
			}
		}
	}
	if columns == 0 {
		return nil
	}
	rows := make([][]string, 0, len(cells)/columns)
	for start := 0; start+columns <= len(cells); start += columns {
		rows = append(rows, cells[start:start+columns])
	}
	return rows
}
