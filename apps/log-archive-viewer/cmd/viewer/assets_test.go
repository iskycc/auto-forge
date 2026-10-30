package main

import (
	"testing"
	"testing/fstest"
)

func TestEmbeddedViewerRequiresScriptStylesAndLicenses(t *testing.T) {
	for _, missing := range []string{"", "index.html", "viewer.js", "viewer.css", "licenses.txt"} {
		t.Run("missing-"+missing, func(t *testing.T) {
			assets := fstest.MapFS{}
			for _, name := range []string{"index.html", "viewer.js", "viewer.css", "licenses.txt"} {
				if name != missing {
					assets[name] = &fstest.MapFile{Data: []byte("compiled offline resource")}
				}
			}
			err := validateViewerAssets(assets)
			if (err != nil) != (missing != "") {
				t.Fatalf("missing %s: %v", missing, err)
			}
		})
	}
	if err := validateViewerAssets(bundledAssets); err == nil {
		t.Fatal("asset validation accepted the wrong embed root")
	}
}
