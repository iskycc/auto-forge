package control

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

type artifactSpool struct {
	root   string
	budget *spoolBudget
}

func newArtifactSpool(dataDirectory string, budget *spoolBudget) (*artifactSpool, error) {
	root := filepath.Join(dataDirectory, "spool", "uploads")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("create artifact upload spool: %w", err)
	}
	spool := &artifactSpool{root: root, budget: budget}
	if err := spool.removeTemporaryFiles(); err != nil {
		return nil, err
	}
	return spool, nil
}

func (spool *artifactSpool) stage(attemptID string, artifact artifactDeclaration, sourcePath string) error {
	if !localIdentifierPattern.MatchString(attemptID) || !localIdentifierPattern.MatchString(artifact.ArtifactID) {
		return errors.New("artifact spool identity is invalid")
	}
	if artifact.SizeBytes <= 0 || !sha256Pattern.MatchString(artifact.SHA256) {
		return errors.New("artifact spool metadata is invalid")
	}
	destination := spool.path(attemptID, artifact.ArtifactID)
	if err := verifySpooledArtifact(destination, artifact); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := spool.budget.reservePayload(artifact.SizeBytes); err != nil {
		return err
	}
	reserved := true
	defer func() {
		if reserved {
			spool.budget.release(artifact.SizeBytes)
		}
	}()
	directory := filepath.Dir(destination)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create artifact attempt spool: %w", err)
	}
	source, err := os.Open(sourcePath)
	if err != nil {
		return fmt.Errorf("open artifact for spooling: %w", err)
	}
	defer source.Close()
	temporary, err := os.CreateTemp(directory, ".upload-*")
	if err != nil {
		return fmt.Errorf("create temporary artifact spool: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("secure temporary artifact spool: %w", err)
	}
	digest := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(temporary, digest), io.LimitReader(source, artifact.SizeBytes+1))
	if copyErr != nil {
		temporary.Close()
		return fmt.Errorf("spool artifact content: %w", copyErr)
	}
	if written != artifact.SizeBytes || hex.EncodeToString(digest.Sum(nil)) != artifact.SHA256 {
		temporary.Close()
		return errors.New("artifact changed before it could be spooled")
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return fmt.Errorf("sync artifact spool: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close artifact spool: %w", err)
	}
	if err := os.Rename(temporaryPath, destination); err != nil {
		return fmt.Errorf("publish artifact spool: %w", err)
	}
	reserved = false
	return nil
}

func verifySpooledArtifact(path string, artifact artifactDeclaration) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() != artifact.SizeBytes {
		return errors.New("spooled artifact metadata is unsafe or inconsistent")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	digest := sha256.New()
	_, copyErr := io.Copy(digest, file)
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil {
		return errors.Join(copyErr, closeErr)
	}
	if hex.EncodeToString(digest.Sum(nil)) != artifact.SHA256 {
		return errors.New("spooled artifact SHA-256 does not match its declaration")
	}
	return nil
}

func (spool *artifactSpool) path(attemptID, artifactID string) string {
	return filepath.Join(spool.root, attemptID, artifactID+".bin")
}

func (spool *artifactSpool) verify(attemptID string, artifact artifactDeclaration) error {
	if !localIdentifierPattern.MatchString(attemptID) || !localIdentifierPattern.MatchString(artifact.ArtifactID) {
		return errors.New("artifact spool identity is invalid")
	}
	return verifySpooledArtifact(spool.path(attemptID, artifact.ArtifactID), artifact)
}

func (spool *artifactSpool) removeAttempt(attemptID string) error {
	if !localIdentifierPattern.MatchString(attemptID) {
		return errors.New("artifact spool attempt identifier is invalid")
	}
	directory := filepath.Join(spool.root, attemptID)
	bytes, err := directorySize(directory)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("measure artifact attempt spool: %w", err)
	}
	if err := os.RemoveAll(directory); err != nil {
		return fmt.Errorf("remove artifact attempt spool: %w", err)
	}
	spool.budget.release(bytes)
	return nil
}

func (spool *artifactSpool) removeTemporaryFiles() error {
	return filepath.WalkDir(spool.root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || filepath.Ext(path) == ".bin" {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if err := os.Remove(path); err != nil {
			return err
		}
		spool.budget.release(info.Size())
		return nil
	})
}
