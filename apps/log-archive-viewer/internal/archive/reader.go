package archive

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
)

type Reader struct {
	mutex    sync.Mutex
	catalogs map[string][]CatalogFrame
	Source   RangeReader
	Manifest Manifest
}

func Open(source RangeReader) (*Reader, error) {
	bytes, err := source.ReadFile("manifest.json", 64*1024*1024)
	if err != nil {
		return nil, fmt.Errorf("read manifest (extract the entire archive first): %w", err)
	}
	var manifest Manifest
	if err = json.Unmarshal(bytes, &manifest); err != nil {
		return nil, err
	}
	if manifest.Format != "autoforge-log-archive" || manifest.SchemaVersion != 1 || manifest.BatchCount != len(manifest.Batches) {
		return nil, errors.New("unsupported archive manifest")
	}
	return &Reader{Source: source, Manifest: manifest, catalogs: make(map[string][]CatalogFrame)}, nil
}
func (r *Reader) Catalog(batch string) ([]CatalogFrame, error) {
	r.mutex.Lock()
	cached, ok := r.catalogs[batch]
	r.mutex.Unlock()
	if ok {
		return cached, nil
	}
	found := false
	for _, item := range r.Manifest.Batches {
		if item.ID == batch {
			found = true
			break
		}
	}
	if !found {
		return nil, errors.New("batch is not in this archive")
	}
	encoded, err := r.Source.ReadFile("batches/"+batch+"/catalog.index.json", 32*1024*1024)
	if err != nil {
		return nil, err
	}
	var frames []CatalogFrame
	if err = json.Unmarshal(encoded, &frames); err != nil {
		return nil, err
	}
	r.mutex.Lock()
	if len(r.catalogs) >= 4 {
		for key := range r.catalogs {
			delete(r.catalogs, key)
			break
		}
	}
	r.catalogs[batch] = frames
	r.mutex.Unlock()
	return frames, nil
}
func (r *Reader) catalogPage(batch string, frame CatalogFrame) ([]Attempt, error) {
	encoded, err := r.Source.ReadRange("batches/"+batch+"/catalog.aflog", frame.Offset, frame.Length)
	if err != nil {
		return nil, err
	}
	var attempts []Attempt
	if err = DecodeFrame(encoded, &attempts); err != nil {
		return nil, err
	}
	if len(attempts) != frame.Count || len(attempts) == 0 || attempts[0].ID != frame.FirstID || attempts[len(attempts)-1].ID != frame.LastID {
		return nil, errors.New("catalog index does not match content")
	}
	return attempts, nil
}

type AttemptPage struct {
	Items      []Attempt `json:"items"`
	HasMore    bool      `json:"hasMore"`
	NextCursor string    `json:"nextCursor,omitempty"`
}

func (r *Reader) Attempts(batch, cursor, query string, limit int) (AttemptPage, error) {
	if limit < 1 || limit > 50 {
		return AttemptPage{}, errors.New("invalid attempt page size")
	}
	frames, err := r.Catalog(batch)
	if err != nil {
		return AttemptPage{}, err
	}
	result := AttemptPage{Items: make([]Attempt, 0, limit)}
	start := sort.Search(len(frames), func(i int) bool { return frames[i].LastID > cursor })
	scanned := 0
	for frameNumber := start; frameNumber < len(frames); frameNumber++ {
		page, err := r.catalogPage(batch, frames[frameNumber])
		if err != nil {
			return AttemptPage{}, err
		}
		for _, attempt := range page {
			if attempt.ID <= cursor {
				continue
			}
			scanned++
			if query != "" && !strings.Contains(strings.ToLower(attempt.ClassName+" "+attempt.DisplayName+" "+attempt.CaseID), strings.ToLower(query)) {
				result.NextCursor = attempt.ID
				continue
			}
			if len(result.Items) == limit {
				result.HasMore = true
				return result, nil
			}
			result.Items = append(result.Items, attempt)
			result.NextCursor = attempt.ID
		}
		if scanned >= 10000 && query != "" {
			result.HasMore = frameNumber+1 < len(frames)
			return result, nil
		}
	}
	return result, nil
}
func (r *Reader) Attempt(batch, id string) (Attempt, error) {
	frames, err := r.Catalog(batch)
	if err != nil {
		return Attempt{}, err
	}
	index := sort.Search(len(frames), func(i int) bool { return frames[i].LastID >= id })
	if index >= len(frames) {
		return Attempt{}, errors.New("attempt not found")
	}
	page, err := r.catalogPage(batch, frames[index])
	if err != nil {
		return Attempt{}, err
	}
	for _, attempt := range page {
		if attempt.ID == id {
			return attempt, nil
		}
	}
	return Attempt{}, errors.New("attempt not found")
}
func (r *Reader) Chunks(batch, id, stream string, after int64, limit int) ([]Chunk, bool, error) {
	attempt, err := r.Attempt(batch, id)
	if err != nil {
		return nil, false, err
	}
	index, ok := attempt.Streams[stream]
	if !ok {
		return nil, false, errors.New("invalid log stream")
	}
	readDescriptor := func(number int) ([]byte, error) {
		return r.Source.ReadRange("batches/"+batch+"/frames.bin", index.IndexOffset+int64(number)*32, 32)
	}
	low, high := 0, index.FrameCount
	for low < high {
		middle := (low + high) / 2
		descriptor, err := readDescriptor(middle)
		if err != nil {
			return nil, false, err
		}
		last := binary.LittleEndian.Uint64(descriptor[16:24])
		if last <= uint64(max(after, 0)) && after >= 0 {
			low = middle + 1
		} else {
			high = middle
		}
	}
	result := make([]Chunk, 0, limit)
	bytes := 0
	for number := low; number < index.FrameCount; number++ {
		descriptor, err := readDescriptor(number)
		if err != nil {
			return nil, false, err
		}
		offset := int64(binary.LittleEndian.Uint64(descriptor[:8]))
		length := int64(binary.LittleEndian.Uint32(descriptor[24:28]))
		encoded, err := r.Source.ReadRange("batches/"+batch+"/logs.aflog", offset, length)
		if err != nil {
			return nil, false, err
		}
		var chunks []Chunk
		if err = DecodeFrame(encoded, &chunks); err != nil {
			return nil, false, err
		}
		for _, chunk := range chunks {
			if chunk.AttemptID != id || chunk.Stream != stream || (chunk.FrameIndex == nil || *chunk.FrameIndex != number) {
				return nil, false, errors.New("log frame does not match its attempt, stream or ordinal")
			}
			if chunk.Sequence <= after {
				continue
			}
			if len(result) == limit || (len(result) > 0 && bytes+len([]byte(chunk.Content)) > 1024*1024) {
				return result, true, nil
			}
			chunk.AttemptID = ""
			chunk.FrameIndex = nil
			result = append(result, chunk)
			bytes += len([]byte(chunk.Content))
		}
	}
	return result, false, nil
}
