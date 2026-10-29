package archive

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCanonicalSourceHashMatchesNodeUTF8Vector(t *testing.T) {
	hash := sha256.New()
	HashChunk(hash, Chunk{Stream: "stdout", Sequence: 7, RecordedAt: "2026-10-27T12:00:00.000Z", Content: "Wallet 中文\x00🚀\n"})
	if hex.EncodeToString(hash.Sum(nil)) != "6c9749b8607a3ff18653fd8d2c0ac82876e5ffb9ee6344ca10297c24f23e9cbc" {
		t.Fatal("Node and Go canonical log hashes differ")
	}
}
func TestFrameRejectsCorruptionAndExpansionBomb(t *testing.T) {
	encoded := testFrame(t, []Chunk{{Stream: "stdout", Sequence: 0, Content: "中文\x00🚀"}})
	var result []Chunk
	if err := DecodeFrame(encoded, &result); err != nil || len(result) != 1 {
		t.Fatalf("valid frame: %v", err)
	}
	encoded[len(encoded)-1] ^= 1
	if err := DecodeFrame(encoded, &result); err == nil {
		t.Fatal("corrupt frame accepted")
	}
	encoded = testFrame(t, []string{"small"})
	binary.LittleEndian.PutUint32(encoded[12:16], MaxFrameBytes+1)
	if err := DecodeFrame(encoded, &result); err == nil {
		t.Fatal("oversized frame accepted")
	}
}
func TestZipVerifierDetectsOmissionDespiteRecomputedFileChecksums(t *testing.T) {
	for _, omit := range []bool{false, true} {
		t.Run(map[bool]string{false: "complete", true: "omitted-source-chunk"}[omit], func(t *testing.T) {
			filename := fixtureZip(t, omit)
			err := Verify(filename)
			if omit {
				if err == nil || !strings.Contains(err.Error(), "source log verification failed") {
					t.Fatalf("source omission not detected: %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if !omit {
				index, err := Index(filename)
				if err != nil {
					t.Fatal(err)
				}
				if index.SchemaVersion != 1 || index.Entries["batches/batch/logs.aflog"].SizeBytes <= 0 {
					t.Fatal("missing range index")
				}
			}
		})
	}
}
func TestDirectoryRejectsTraversalAndSymlinks(t *testing.T) {
	root := t.TempDir()
	source := Directory{Root: root}
	for _, name := range []string{"../secret", "/etc/passwd", "a\\b"} {
		if _, err := source.ReadFile(name, 100); err == nil {
			t.Fatalf("accepted %s", name)
		}
	}
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "link")); err == nil {
		if _, err = source.ReadFile("link", 100); err == nil {
			t.Fatal("followed external symlink")
		}
	}
}
func testFrame(t *testing.T, value any) []byte {
	t.Helper()
	plain, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err = writer.Write(plain); err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	header := make([]byte, 48)
	copy(header, "AFLC")
	binary.LittleEndian.PutUint16(header[4:6], 1)
	binary.LittleEndian.PutUint32(header[8:12], uint32(compressed.Len()))
	binary.LittleEndian.PutUint32(header[12:16], uint32(len(plain)))
	digest := sha256.Sum256(plain)
	copy(header[16:], digest[:])
	return append(header, compressed.Bytes()...)
}
func fixtureZip(t *testing.T, omit bool) string {
	t.Helper()
	source := []Chunk{{Stream: "stdout", Sequence: 0, Content: "one中文\x00", RecordedAt: "2026-10-27T12:00:00.000Z"}, {Stream: "stdout", Sequence: 1, Content: "two🚀", RecordedAt: "2026-10-27T12:00:01.000Z"}}
	for index := range source {
		source[index].AttemptID = "attempt"
		ordinal := 0
		source[index].FrameIndex = &ordinal
	}
	hash := sha256.New()
	for _, row := range source {
		HashChunk(hash, row)
	}
	rows := source
	if omit {
		rows = rows[:1]
	}
	logFrame := testFrame(t, rows)
	descriptor := make([]byte, 32)
	binary.LittleEndian.PutUint64(descriptor[16:24], uint64(rows[len(rows)-1].Sequence))
	binary.LittleEndian.PutUint32(descriptor[24:28], uint32(len(logFrame)))
	binary.LittleEndian.PutUint32(descriptor[28:32], binary.LittleEndian.Uint32(logFrame[12:16]))
	empty := sha256.Sum256(nil)
	emptyHash := hex.EncodeToString(empty[:])
	attempt := Attempt{ID: "attempt", Streams: map[string]StreamIndex{"stdout": {SourceHash: hex.EncodeToString(hash.Sum(nil)), IndexOffset: 0, FrameCount: 1, ChunkCount: 2, RawBytes: int64(len([]byte(source[0].Content)) + len([]byte(source[1].Content))), AcknowledgedSequence: 1}, "stderr": {SourceHash: emptyHash, IndexOffset: 32, AcknowledgedSequence: -1}, "agent": {SourceHash: emptyHash, IndexOffset: 32, AcknowledgedSequence: -1}}}
	catalog := testFrame(t, []Attempt{attempt})
	catalogIndex, err := json.Marshal([]CatalogFrame{{FirstID: "attempt", LastID: "attempt", Length: int64(len(catalog)), Count: 1}})
	if err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{"batches/batch/logs.aflog": logFrame, "batches/batch/frames.bin": descriptor, "batches/batch/catalog.aflog": catalog, "batches/batch/catalog.index.json": catalogIndex}
	manifest := Manifest{Format: "autoforge-log-archive", SchemaVersion: 1, ID: "fixture", Month: "2026-10", BatchCount: 1, AttemptCount: 1, ChunkCount: 2, RawBytes: attempt.Streams["stdout"].RawBytes, Batches: []Batch{{ID: "batch"}}}
	for name, content := range files {
		digest := sha256.Sum256(content)
		manifest.Files = append(manifest.Files, File{Path: name, SizeBytes: int64(len(content)), SHA256: hex.EncodeToString(digest[:])})
	}
	files["manifest.json"], err = json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(t.TempDir(), "fixture.zip")
	file, err := os.Create(filename)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	for name, content := range files {
		entry, err := writer.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = entry.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err = file.Close(); err != nil {
		t.Fatal(err)
	}
	return filename
}
