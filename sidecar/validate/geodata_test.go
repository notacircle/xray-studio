package validate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func withAssets(t *testing.T, files ...string) string {
	t.Helper()
	dir := t.TempDir()
	for _, f := range files {
		if err := os.WriteFile(filepath.Join(dir, f), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("XRAY_LOCATION_ASSET", dir)
	return dir
}

// The report the user actually got, turned into one that says what to do.
func TestGeodataMissingIsNamed(t *testing.T) {
	withAssets(t) // an empty directory: nothing to find
	d := Geodata([]byte(`{"routing":{"rules":[{"ip":["geoip:ru"],"outboundTag":"direct"}]}}`))
	if len(d) != 1 {
		t.Fatalf("want one finding, got %d: %+v", len(d), d)
	}
	if d[0].Code != "geodata_missing" || d[0].Severity != "error" {
		t.Errorf("wrong code/severity: %+v", d[0])
	}
	if !strings.Contains(d[0].Message, "geoip:ru") || !strings.Contains(d[0].Message, "geoip.dat") {
		t.Errorf("the message should name the rule and the file: %s", d[0].Message)
	}
	if !strings.Contains(d[0].Detail, "Geodata") {
		t.Errorf("the detail should point at the fix: %s", d[0].Detail)
	}
	if d[0].Path != "routing.rules[0].ip" {
		t.Errorf("path = %q", d[0].Path)
	}
}

// Each file is checked on its own — a profile may carry only one of them.
func TestGeodataChecksEachFileSeparately(t *testing.T) {
	withAssets(t, "geoip.dat")
	d := Geodata([]byte(`{
	  "routing":{"rules":[{"ip":["geoip:cn"]},{"domain":["geosite:google"]}]}
	}`))
	if len(d) != 1 || !strings.Contains(d[0].Message, "geosite.dat") {
		t.Fatalf("only geosite should be missing, got %+v", d)
	}
}

// Present files, and configs that need neither, produce nothing.
func TestGeodataSilentWhenSatisfied(t *testing.T) {
	withAssets(t, "geoip.dat", "geosite.dat")
	if d := Geodata([]byte(`{"routing":{"rules":[{"ip":["geoip:ru"],"domain":["geosite:ru"]}]}}`)); len(d) != 0 {
		t.Errorf("files present, expected nothing: %+v", d)
	}
	withAssets(t)
	if d := Geodata([]byte(`{"routing":{"rules":[{"ip":["10.0.0.0/8"],"domain":["example.com"]}]}}`)); len(d) != 0 {
		t.Errorf("no geo references, expected nothing: %+v", d)
	}
}

// DNS server lists reference geosite/geoip too, and a bare string is a valid list.
func TestGeodataSeesDNSAndBareStrings(t *testing.T) {
	withAssets(t)
	d := Geodata([]byte(`{"dns":{"servers":[{"address":"1.1.1.1","domains":"geosite:cn","expectIPs":["geoip:cn"]}]}}`))
	if len(d) != 2 {
		t.Fatalf("want geosite and geoip both reported, got %+v", d)
	}
}
