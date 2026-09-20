package validate

import (
	"encoding/json"
	"os"
	"strings"

	"github.com/xtls/xray-core/common/platform"

	"xraystudio/sidecar/trace"
)

// Geodata reports geoip:/geosite: references whose .dat file the core will not find.
//
// Without this the failure arrives from deep inside the loader as
//
//	common/geodata: failed to open geoip.dat > stat /Applications/Xray Studio.app/
//	Contents/Resources/geoip.dat: no such file or directory
//
// which is accurate and useless: it names a path inside a read-only bundle that was
// never going to contain the file, and says nothing about where the file is supposed
// to come from. The fix is a geodata profile, and the diagnostic should point there.
//
// Resolved through the same platform.GetAssetLocation the core uses, so this check and
// the core cannot disagree about which file is being looked for.
func Geodata(raw []byte) []trace.Diagnostic {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil // the parse phase reports malformed JSON with a position
	}

	needIP, needSite := false, false
	var firstIP, firstSite string
	note := func(s, where string) {
		switch {
		case strings.HasPrefix(s, "geoip:"):
			if !needIP {
				firstIP = where + " → " + s
			}
			needIP = true
		case strings.HasPrefix(s, "geosite:"):
			if !needSite {
				firstSite = where + " → " + s
			}
			needSite = true
		}
	}

	// Routing rules: ip and domain lists.
	if routing, ok := doc["routing"].(map[string]any); ok {
		if rules, ok := routing["rules"].([]any); ok {
			for i, r := range rules {
				rule, _ := r.(map[string]any)
				for _, key := range []string{"ip", "domain", "source"} {
					for _, v := range strList(rule[key]) {
						note(v, "routing.rules["+itoa(i)+"]."+key)
					}
				}
			}
		}
	}
	// DNS servers: domains and expected IPs.
	if dns, ok := doc["dns"].(map[string]any); ok {
		if servers, ok := dns["servers"].([]any); ok {
			for i, sv := range servers {
				srv, _ := sv.(map[string]any)
				for _, key := range []string{"domains", "expectIPs", "expectedIPs"} {
					for _, v := range strList(srv[key]) {
						note(v, "dns.servers["+itoa(i)+"]."+key)
					}
				}
			}
		}
	}

	var out []trace.Diagnostic
	check := func(need bool, file, first string) {
		if !need {
			return
		}
		path := platform.GetAssetLocation(file)
		if _, err := os.Stat(path); err == nil {
			return
		}
		out = append(out, trace.Diagnostic{
			Severity: "error",
			Code:     "geodata_missing",
			Path:     strings.SplitN(first, " → ", 2)[0],
			Message:  "The config uses " + strings.SplitN(first, " → ", 2)[1] + ", but " + file + " is not available.",
			Detail: "Xray will refuse to start. Open Geodata in the top bar and choose a profile " +
				"that provides " + file + " — or add one from a URL or a happ:// routing link. " +
				"Looked for it at " + path + ".",
		})
	}
	check(needIP, "geoip.dat", firstIP)
	check(needSite, "geosite.dat", firstSite)
	return out
}

// strList reads a JSON value that Xray accepts as either a string or an array of
// strings, the way its StringList does.
func strList(v any) []string {
	switch x := v.(type) {
	case string:
		return []string{x}
	case []any:
		out := make([]string, 0, len(x))
		for _, e := range x {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}
