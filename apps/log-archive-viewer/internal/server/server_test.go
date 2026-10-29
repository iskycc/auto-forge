package server

import (
	"github.com/iskycc/auto-forge/apps/log-archive-viewer/internal/archive"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestViewerRejectsCrossOriginAndWriteRequests(t *testing.T) {
	handler := New(&archive.Reader{Manifest: archive.Manifest{Month: "2026-10", BatchCount: 1, Batches: []archive.Batch{{ID: "private-batch"}}}}, fstest.MapFS{"index.html": {Data: []byte("offline")}}, "127.0.0.1:7777")
	for _, test := range []struct {
		method, host, origin, path string
		status                     int
	}{{"GET", "evil.test", "", "/", 403}, {"GET", "127.0.0.1:7777", "http://evil.test", "/api/manifest", 403}, {"POST", "127.0.0.1:7777", "", "/api/manifest", 405}, {"GET", "127.0.0.1:7777", "", "/secret.txt", 404}, {"GET", "127.0.0.1:7777", "", "/api/logs?afterSequence=oops", 400}, {"GET", "127.0.0.1:7777", "", "/api/manifest", 200}} {
		request := httptest.NewRequest(test.method, "http://"+test.host+test.path, nil)
		request.Host = test.host
		if test.origin != "" {
			request.Header.Set("Origin", test.origin)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != test.status {
			t.Errorf("%s %s: %d != %d", test.method, test.path, response.Code, test.status)
		}
		if test.path == "/api/manifest" && test.status == http.StatusOK && strings.Contains(response.Body.String(), "private-batch") {
			t.Fatal("summary API included the complete archive catalog")
		}
	}
}
