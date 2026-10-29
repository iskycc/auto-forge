package server

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/iskycc/auto-forge/apps/log-archive-viewer/internal/archive"
)

type Server struct {
	reader *archive.Reader
	assets fs.FS
	host   string
	slots  chan struct{}
}

func New(reader *archive.Reader, assets fs.FS, host string) http.Handler {
	return &Server{reader: reader, assets: assets, host: host, slots: make(chan struct{}, 4)}
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
	if r.Host != s.host {
		http.Error(w, "invalid host", http.StatusForbidden)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		parsed, err := url.Parse(origin)
		if err != nil || parsed.Host != s.host || parsed.Scheme != "http" {
			http.Error(w, "invalid origin", http.StatusForbidden)
			return
		}
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "read only", http.StatusMethodNotAllowed)
		return
	}
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		http.Error(w, "viewer is busy", http.StatusTooManyRequests)
		return
	}
	query := r.URL.Query()
	w.Header().Set("Cache-Control", "no-store")
	switch r.URL.Path {
	case "/api/manifest":
		manifest := s.reader.Manifest
		s.json(w, map[string]any{"volumeNumber": manifest.VolumeNumber, "groupId": manifest.GroupID, "month": manifest.Month, "timeZone": manifest.TimeZone, "batchCount": manifest.BatchCount, "attemptCount": manifest.AttemptCount, "chunkCount": manifest.ChunkCount, "rawBytes": manifest.RawBytes})
	case "/api/batches":
		cursor := query.Get("cursor")
		search := strings.ToLower(query.Get("query"))
		items := make([]archive.Batch, 0, 50)
		more := false
		for _, batch := range s.reader.Manifest.Batches {
			if id := query.Get("batchId"); id != "" && batch.ID != id {
				continue
			}
			if batch.ID <= cursor {
				continue
			}
			if search != "" && !strings.Contains(strings.ToLower(batch.SuiteName+" "+batch.ProjectName+" "+batch.ProjectVersionName), search) {
				continue
			}
			if len(items) == 50 {
				more = true
				break
			}
			items = append(items, batch)
		}
		s.json(w, map[string]any{"items": items, "hasMore": more})
	case "/api/attempts":
		if len(query.Get("query")) > 512 {
			http.Error(w, "query too long", 400)
			return
		}
		result, err := s.reader.Attempts(query.Get("batchId"), query.Get("cursor"), query.Get("query"), 50)
		if err != nil {
			s.fail(w, err)
			return
		}
		s.json(w, result)
	case "/api/logs":
		after := int64(-1)
		var err error
		if query.Has("afterSequence") {
			after, err = strconv.ParseInt(query.Get("afterSequence"), 10, 64)
			if err != nil || after < -1 {
				http.Error(w, "invalid sequence", 400)
				return
			}
		}
		items, more, err := s.reader.Chunks(query.Get("batchId"), query.Get("attemptId"), query.Get("stream"), after, 100)
		if err != nil {
			s.fail(w, err)
			return
		}
		s.json(w, map[string]any{"items": items, "hasMore": more})
	default:
		if r.URL.Path != "/" && r.URL.Path != "/viewer.js" && r.URL.Path != "/viewer.css" && r.URL.Path != "/viewer.js.LEGAL.txt" && r.URL.Path != "/licenses.txt" {
			http.NotFound(w, r)
			return
		}
		http.FileServer(http.FS(s.assets)).ServeHTTP(w, r)
	}
}
func (s *Server) json(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		return
	}
}
func (s *Server) fail(w http.ResponseWriter, err error) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusUnprocessableEntity)
	s.json(w, map[string]string{"message": err.Error()})
}
