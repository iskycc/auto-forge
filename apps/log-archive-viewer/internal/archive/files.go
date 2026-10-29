package archive

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

type Directory struct{ Root string }

func SafePath(name string) bool {
	return name != "." && fs.ValidPath(name) && !strings.Contains(name, "\\") && path.Clean(name) == name
}
func (d Directory) open(name string) (*os.File, error) {
	if !SafePath(name) {
		return nil, errors.New("invalid archive path")
	}
	current := d.Root
	for _, part := range strings.Split(name, "/") {
		current = filepath.Join(current, part)
		metadata, err := os.Lstat(current)
		if err != nil {
			return nil, err
		}
		if metadata.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("archive symlinks are not supported")
		}
	}
	return os.Open(current)
}
func (d Directory) ReadFile(name string, maximum int64) ([]byte, error) {
	file, err := d.open(name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	metadata, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !metadata.Mode().IsRegular() || metadata.Size() > maximum {
		return nil, errors.New("archive file exceeds read budget")
	}
	return io.ReadAll(io.LimitReader(file, maximum+1))
}
func (d Directory) ReadRange(name string, offset, length int64) ([]byte, error) {
	if offset < 0 || length < 0 || length > MaxFrameBytes+1024*1024 {
		return nil, errors.New("invalid archive range")
	}
	file, err := d.open(name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	buffer := make([]byte, int(length))
	_, err = file.ReadAt(buffer, offset)
	return buffer, err
}
