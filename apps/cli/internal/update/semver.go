package update

import (
	"fmt"
	"strconv"
	"strings"
)

type semver struct {
	core [3]int
	pre  []string
}

func parseSemver(raw string) (semver, error) {
	text := strings.TrimPrefix(strings.TrimSpace(raw), "v")
	text, _, _ = strings.Cut(text, "+")
	core, pre, hasPre := strings.Cut(text, "-")
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return semver{}, fmt.Errorf("versión inválida %q", raw)
	}
	var v semver
	for i, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 {
			return semver{}, fmt.Errorf("versión inválida %q", raw)
		}
		v.core[i] = n
	}
	if hasPre {
		v.pre = strings.Split(pre, ".")
	}
	return v, nil
}

// compareVersions sigue la precedencia de semver 2.0: una versión con sufijo
// de prelanzamiento (2.3.0-go.0) es anterior a la misma sin sufijo (2.3.0).
func compareVersions(a, b string) (int, error) {
	x, err := parseSemver(a)
	if err != nil {
		return 0, err
	}
	y, err := parseSemver(b)
	if err != nil {
		return 0, err
	}
	for i := range x.core {
		if x.core[i] != y.core[i] {
			return sign(x.core[i] - y.core[i]), nil
		}
	}
	switch {
	case len(x.pre) == 0 && len(y.pre) == 0:
		return 0, nil
	case len(x.pre) == 0:
		return 1, nil
	case len(y.pre) == 0:
		return -1, nil
	}
	for i := 0; i < min(len(x.pre), len(y.pre)); i++ {
		if c := comparePreIdentifier(x.pre[i], y.pre[i]); c != 0 {
			return c, nil
		}
	}
	return sign(len(x.pre) - len(y.pre)), nil
}

func comparePreIdentifier(a, b string) int {
	na, errA := strconv.Atoi(a)
	nb, errB := strconv.Atoi(b)
	switch {
	case errA == nil && errB == nil:
		return sign(na - nb)
	case errA == nil:
		return -1
	case errB == nil:
		return 1
	}
	return sign(strings.Compare(a, b))
}

func sign(n int) int {
	switch {
	case n < 0:
		return -1
	case n > 0:
		return 1
	}
	return 0
}
