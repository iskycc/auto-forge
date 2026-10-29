package archive

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
)

const MaxFrameBytes = 8 * 1024 * 1024

func DecodeFrame(encoded []byte, target any) error {
	if len(encoded) < 48 || string(encoded[:4]) != "AFLC" || binary.LittleEndian.Uint16(encoded[4:6]) != 1 {
		return errors.New("invalid log frame header")
	}
	size := binary.LittleEndian.Uint32(encoded[12:16])
	if size > MaxFrameBytes || uint64(binary.LittleEndian.Uint32(encoded[8:12])) != uint64(len(encoded)-48) {
		return errors.New("invalid log frame length")
	}
	reader, err := gzip.NewReader(bytes.NewReader(encoded[48:]))
	if err != nil {
		return err
	}
	plain, err := io.ReadAll(io.LimitReader(reader, MaxFrameBytes+1))
	closeErr := reader.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	checksum := sha256.Sum256(plain)
	if len(plain) != int(size) || !bytes.Equal(checksum[:], encoded[16:48]) {
		return errors.New("log frame checksum mismatch")
	}
	if err := json.Unmarshal(plain, target); err != nil {
		return fmt.Errorf("decode log frame: %w", err)
	}
	return nil
}
func HashChunk(digest hash.Hash, chunk Chunk) {
	var prefix [12]byte
	binary.LittleEndian.PutUint64(prefix[:8], uint64(chunk.Sequence))
	binary.LittleEndian.PutUint32(prefix[8:], uint32(len([]byte(chunk.RecordedAt))))
	var size [4]byte
	binary.LittleEndian.PutUint32(size[:], uint32(len([]byte(chunk.Content))))
	digest.Write(prefix[:])
	digest.Write([]byte(chunk.RecordedAt))
	digest.Write(size[:])
	digest.Write([]byte(chunk.Content))
}
