package archive

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

type zipSource struct{ files map[string]*zip.File }

func (s zipSource) ReadFile(name string, maximum int64) ([]byte, error) {
	file := s.files[name]
	if file == nil || file.UncompressedSize64 > uint64(maximum) {
		return nil, errors.New("missing or oversized archive file")
	}
	reader, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	return io.ReadAll(io.LimitReader(reader, maximum+1))
}
func (s zipSource) ReadRange(name string, offset, length int64) ([]byte, error) {
	if offset < 0 || length < 0 || length > MaxFrameBytes+1024*1024 {
		return nil, errors.New("invalid ZIP range")
	}
	file := s.files[name]
	if file == nil || uint64(offset+length) > file.UncompressedSize64 {
		return nil, errors.New("ZIP range exceeds file")
	}
	// Random access to stored entries is provided by zip.File.Open's section reader.
	reader, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	if seeker, ok := reader.(io.Seeker); ok {
		if _, err = seeker.Seek(offset, io.SeekStart); err != nil {
			return nil, err
		}
	} else {
		if _, err = io.CopyN(io.Discard, reader, offset); err != nil {
			return nil, err
		}
	}
	result := make([]byte, int(length))
	_, err = io.ReadFull(reader, result)
	return result, err
}

// zipRangeSource uses raw section offsets for STORE files. Verification remains linear in archive size.
type zipRangeSource struct {
	zipSource
	file *os.File
}

func (s zipRangeSource) ReadRange(name string, offset, length int64) ([]byte, error) {
	file := s.files[name]
	if file == nil || file.Method != zip.Store || offset < 0 || length < 0 || length > MaxFrameBytes+1024*1024 || uint64(offset+length) > file.UncompressedSize64 {
		return nil, errors.New("invalid stored ZIP range")
	}
	start, err := file.DataOffset()
	if err != nil {
		return nil, err
	}
	result := make([]byte, int(length))
	_, err = s.file.ReadAt(result, start+offset)
	return result, err
}
func Pack(directory, filename, indexFilename string) error {
	destination, err := os.OpenFile(filename, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	writer := zip.NewWriter(destination)
	walkErr := filepath.WalkDir(directory, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		metadata, err := entry.Info()
		if err != nil {
			return err
		}
		if !metadata.Mode().IsRegular() {
			return errors.New("archive inputs must be regular files")
		}
		relative, err := filepath.Rel(directory, name)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if !SafePath(relative) {
			return errors.New("invalid ZIP input path")
		}
		header, err := zip.FileInfoHeader(metadata)
		if err != nil {
			return err
		}
		header.Name = relative
		header.Method = zip.Store
		if strings.HasPrefix(relative, "viewer-") {
			header.Method = zip.Deflate
			header.SetMode(0755)
		}
		target, err := writer.CreateHeader(header)
		if err != nil {
			return err
		}
		source, err := os.Open(name)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(target, source)
		closeErr := source.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	})
	zipErr := writer.Close()
	fileErr := destination.Close()
	if err = errors.Join(walkErr, zipErr, fileErr); err != nil {
		return err
	}
	if err = Verify(filename); err != nil {
		return err
	}
	index, err := Index(filename)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(index)
	if err != nil {
		return err
	}
	return os.WriteFile(indexFilename, encoded, 0600)
}
func Index(filename string) (ObjectIndex, error) {
	reader, err := zip.OpenReader(filename)
	if err != nil {
		return ObjectIndex{}, err
	}
	defer reader.Close()
	metadata, err := os.Stat(filename)
	if err != nil {
		return ObjectIndex{}, err
	}
	result := ObjectIndex{SchemaVersion: 1, ArchiveBytes: metadata.Size(), Entries: map[string]Entry{}}
	for _, file := range reader.File {
		if file.Method != zip.Store {
			continue
		}
		offset, err := file.DataOffset()
		if err != nil {
			return result, err
		}
		result.Entries[file.Name] = Entry{Offset: offset, SizeBytes: int64(file.UncompressedSize64)}
	}
	return result, nil
}
func Verify(filename string) error {
	reader, err := zip.OpenReader(filename)
	if err != nil {
		return err
	}
	defer reader.Close()
	raw, err := os.Open(filename)
	if err != nil {
		return err
	}
	defer raw.Close()
	source := zipRangeSource{zipSource: zipSource{files: map[string]*zip.File{}}, file: raw}
	for _, file := range reader.File {
		if !SafePath(file.Name) || source.files[file.Name] != nil {
			return errors.New("invalid or duplicate ZIP entry")
		}
		source.files[file.Name] = file
	}
	parsed, err := Open(source)
	if err != nil {
		return err
	}
	manifest := parsed.Manifest
	declared := map[string]bool{"manifest.json": true}
	for _, expected := range manifest.Files {
		file := source.files[expected.Path]
		if file == nil || file.UncompressedSize64 != uint64(expected.SizeBytes) || declared[expected.Path] {
			return errors.New("manifest file sizes do not match archive")
		}
		declared[expected.Path] = true
		content, err := file.Open()
		if err != nil {
			return err
		}
		hash := sha256.New()
		_, copyErr := io.Copy(hash, content)
		closeErr := content.Close()
		if err = errors.Join(copyErr, closeErr); err != nil {
			return err
		}
		if hex.EncodeToString(hash.Sum(nil)) != expected.SHA256 {
			return fmt.Errorf("file checksum mismatch: %s", expected.Path)
		}
	}
	if len(declared) != len(source.files) {
		return errors.New("archive has undeclared files")
	}
	var attempts int
	var chunks, rawBytes int64
	for _, batch := range manifest.Batches {
		catalog, err := parsed.Catalog(batch.ID)
		if err != nil {
			return err
		}
		var expectedOffset, indexOffset int64
		lastID := ""
		for _, frame := range catalog {
			page, err := parsed.catalogPage(batch.ID, frame)
			if err != nil {
				return err
			}
			for _, attempt := range page {
				if attempt.ID <= lastID || len(attempt.Streams) != 3 {
					return errors.New("invalid attempt order or streams")
				}
				lastID = attempt.ID
				attempts++
				for _, stream := range []string{"stdout", "stderr", "agent"} {
					index, ok := attempt.Streams[stream]
					if !ok || index.IndexOffset != indexOffset {
						return errors.New("invalid stream index")
					}
					hash := sha256.New()
					var count, size int64
					lastSequence := int64(-1)
					for number := 0; number < index.FrameCount; number++ {
						descriptor, err := source.ReadRange("batches/"+batch.ID+"/frames.bin", index.IndexOffset+int64(number)*32, 32)
						if err != nil {
							return err
						}
						offset := int64(binary.LittleEndian.Uint64(descriptor[:8]))
						length := int64(binary.LittleEndian.Uint32(descriptor[24:28]))
						if offset != expectedOffset {
							return errors.New("log frame offset gap")
						}
						encoded, err := source.ReadRange("batches/"+batch.ID+"/logs.aflog", offset, length)
						if err != nil {
							return err
						}
						var rows []Chunk
						if err = DecodeFrame(encoded, &rows); err != nil {
							return err
						}
						if len(rows) == 0 || uint64(rows[0].Sequence) != binary.LittleEndian.Uint64(descriptor[8:16]) || uint64(rows[len(rows)-1].Sequence) != binary.LittleEndian.Uint64(descriptor[16:24]) {
							return errors.New("log sequence index mismatch")
						}
						for _, chunk := range rows {
							if chunk.AttemptID != attempt.ID || (chunk.FrameIndex == nil || *chunk.FrameIndex != number) || chunk.Stream != stream || chunk.Sequence <= lastSequence {
								return errors.New("log stream order mismatch")
							}
							HashChunk(hash, chunk)
							count++
							size += int64(len([]byte(chunk.Content)))
							lastSequence = chunk.Sequence
						}
						expectedOffset += length
					}
					if count != index.ChunkCount || size != index.RawBytes || hex.EncodeToString(hash.Sum(nil)) != index.SourceHash {
						return fmt.Errorf("source log verification failed: %s/%s", attempt.ID, stream)
					}
					indexOffset += int64(index.FrameCount) * 32
					chunks += count
					rawBytes += size
				}
			}
		}
		for name, size := range map[string]int64{"logs.aflog": expectedOffset, "frames.bin": indexOffset} {
			file := source.files["batches/"+batch.ID+"/"+name]
			if file == nil || file.UncompressedSize64 != uint64(size) {
				return errors.New("unreferenced log content")
			}
		}
	}
	if attempts != manifest.AttemptCount || chunks != manifest.ChunkCount || rawBytes != manifest.RawBytes {
		return errors.New("manifest log counts do not match source")
	}
	return nil
}
