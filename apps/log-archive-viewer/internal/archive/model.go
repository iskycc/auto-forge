package archive

import "io"

type Batch struct {
	ID                 string `json:"id"`
	ProjectName        string `json:"projectName"`
	ProjectVersionName string `json:"projectVersionName"`
	TestStageName      string `json:"testStageName"`
	SuiteName          string `json:"suiteName"`
	SequenceNumber     int    `json:"sequenceNumber"`
	Status             string `json:"status"`
	FinishedAt         string `json:"finishedAt"`
}
type Manifest struct {
	GroupID        string  `json:"groupId,omitempty"`
	VolumeNumber   int     `json:"volumeNumber,omitempty"`
	SourceCutoffAt string  `json:"sourceCutoffAt,omitempty"`
	Format         string  `json:"format"`
	SchemaVersion  int     `json:"schemaVersion"`
	ID             string  `json:"id"`
	Month          string  `json:"month"`
	TimeZone       string  `json:"timeZone"`
	BatchCount     int     `json:"batchCount"`
	AttemptCount   int     `json:"attemptCount"`
	ChunkCount     int64   `json:"chunkCount"`
	RawBytes       int64   `json:"rawBytes"`
	Batches        []Batch `json:"batches"`
	Files          []File  `json:"files"`
}
type File struct {
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
	SHA256    string `json:"sha256"`
}
type CatalogFrame struct {
	FirstID string `json:"firstId"`
	LastID  string `json:"lastId"`
	Offset  int64  `json:"offset"`
	Length  int64  `json:"length"`
	Count   int    `json:"count"`
}
type StreamIndex struct {
	SourceHash           string `json:"sourceHash"`
	IndexOffset          int64  `json:"indexOffset"`
	FrameCount           int    `json:"frameCount"`
	ChunkCount           int64  `json:"chunkCount"`
	RawBytes             int64  `json:"rawBytes"`
	AcknowledgedSequence int64  `json:"acknowledgedSequence"`
}
type Attempt struct {
	ID             string                 `json:"id"`
	ExecutionRunID string                 `json:"executionRunId"`
	CaseID         string                 `json:"caseId"`
	CaseType       string                 `json:"caseType"`
	ClassName      string                 `json:"className"`
	DisplayName    string                 `json:"displayName"`
	RoundIndex     int                    `json:"roundIndex"`
	AttemptNumber  int                    `json:"attemptNumber"`
	Status         string                 `json:"status"`
	Outcome        string                 `json:"outcome"`
	StartedAt      string                 `json:"startedAt"`
	FinishedAt     string                 `json:"finishedAt"`
	Streams        map[string]StreamIndex `json:"streams"`
}
type Chunk struct {
	AttemptID  string `json:"attemptId,omitempty"`
	FrameIndex *int   `json:"frameIndex,omitempty"`
	Stream     string `json:"stream"`
	Sequence   int64  `json:"sequence"`
	Content    string `json:"content"`
	RecordedAt string `json:"recordedAt"`
}
type Entry struct {
	Offset    int64 `json:"offset"`
	SizeBytes int64 `json:"sizeBytes"`
}
type ObjectIndex struct {
	SchemaVersion int              `json:"schemaVersion"`
	ArchiveBytes  int64            `json:"archiveBytes"`
	Entries       map[string]Entry `json:"entries"`
}
type RangeReader interface {
	ReadRange(string, int64, int64) ([]byte, error)
	ReadFile(string, int64) ([]byte, error)
}
type ReadSeekCloser interface {
	io.Reader
	io.Seeker
	io.Closer
}
