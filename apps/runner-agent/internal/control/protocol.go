package control

type ExecutionInput struct {
	InputID    string `json:"inputId"`
	Kind       string `json:"kind"`
	TargetPath string `json:"targetPath"`
	MediaType  string `json:"mediaType"`
	SizeBytes  int64  `json:"sizeBytes"`
	SHA256     string `json:"sha256"`
}

type EnvironmentEntry struct {
	Name   string `json:"name"`
	Value  string `json:"value"`
	Secret bool   `json:"secret"`
}

type SecretReference struct {
	Name            string `json:"name"`
	SecretID        string `json:"secretId"`
	SecretVersionID string `json:"secretVersionId"`
}

type ResourceLimits struct {
	CPUMillicores int64 `json:"cpuMillicores"`
	MemoryBytes   int64 `json:"memoryBytes"`
	DiskBytes     int64 `json:"diskBytes"`
	ProcessCount  int64 `json:"processCount"`
	FileCount     int64 `json:"fileCount"`
	LogBytes      int64 `json:"logBytes"`
	ArtifactBytes int64 `json:"artifactBytes"`
}

type RuntimeRequirements struct {
	OS                      string   `json:"os"`
	Architectures           []string `json:"architectures"`
	MinimumJavaMajorVersion int      `json:"minimumJavaMajorVersion"`
	TestNGVersion           string   `json:"testNgVersion"`
}

type ExecutionSpec struct {
	SchemaVersion        int                 `json:"schemaVersion"`
	Executor             string              `json:"executor"`
	AttemptID            string              `json:"attemptId"`
	ExecutionRunID       string              `json:"executionRunId"`
	BatchID              string              `json:"batchId"`
	ClassName            string              `json:"className"`
	MethodDescriptors    []string            `json:"methodDescriptors"`
	Parameters           map[string]string   `json:"parameters"`
	Inputs               []ExecutionInput    `json:"inputs"`
	Environment          []EnvironmentEntry  `json:"environment"`
	SecretReferences     []SecretReference   `json:"secretReferences"`
	RuntimeRequirements  RuntimeRequirements `json:"runtimeRequirements"`
	RequiredLabels       []string            `json:"requiredLabels"`
	RequiredCapabilities []string            `json:"requiredCapabilities"`
	ArtifactRules        []ArtifactRule      `json:"artifactRules"`
	TimeoutMs            int64               `json:"timeoutMs"`
	UploadTimeoutMs      int64               `json:"uploadTimeoutMs"`
	ResourceLimits       ResourceLimits      `json:"resourceLimits"`
}

type acquireSecretsRequest struct {
	SchemaVersion int    `json:"schemaVersion"`
	RequestID     string `json:"requestId"`
	LeaseToken    string `json:"leaseToken"`
}

type acquireSecretsResponse struct {
	SchemaVersion int                `json:"schemaVersion"`
	RequestID     string             `json:"requestId"`
	Secrets       []EnvironmentEntry `json:"secrets"`
}

type ArtifactRule struct {
	Pattern   string `json:"pattern"`
	Required  bool   `json:"required"`
	MediaType string `json:"mediaType,omitempty"`
}

type Assignment struct {
	SchemaVersion int           `json:"schemaVersion"`
	AssignmentID  string        `json:"assignmentId"`
	AttemptID     string        `json:"attemptId"`
	RunnerID      string        `json:"runnerId"`
	Priority      int           `json:"priority"`
	AvailableAt   string        `json:"availableAt"`
	ClaimDeadline string        `json:"claimDeadlineAt"`
	CreatedAt     string        `json:"createdAt"`
	ExecutionSpec ExecutionSpec `json:"executionSpec"`
}

type Lease struct {
	LeaseID   string `json:"leaseId"`
	Token     string `json:"token"`
	Version   int    `json:"version"`
	ExpiresAt string `json:"expiresAt"`
}

type ClaimedAssignment struct {
	Assignment Assignment `json:"assignment"`
	Lease      Lease      `json:"lease"`
}

type claimRequest struct {
	SchemaVersion  int      `json:"schemaVersion"`
	RequestID      string   `json:"requestId"`
	AvailableSlots int      `json:"availableSlots"`
	Labels         []string `json:"labels"`
	Capabilities   []string `json:"capabilities"`
	WaitSeconds    int      `json:"waitSeconds"`
}

type ClaimResponse struct {
	SchemaVersion int                 `json:"schemaVersion"`
	RequestID     string              `json:"requestId"`
	Assignments   []ClaimedAssignment `json:"assignments"`
	RetryAfterMs  int                 `json:"retryAfterMs"`
}

type renewLeaseRequest struct {
	SchemaVersion int    `json:"schemaVersion"`
	RequestID     string `json:"requestId"`
	LeaseToken    string `json:"leaseToken"`
	LeaseVersion  int    `json:"leaseVersion"`
}

type RenewLeaseResponse struct {
	SchemaVersion int    `json:"schemaVersion"`
	AcceptedAt    string `json:"acceptedAt"`
	LeaseVersion  int    `json:"leaseVersion"`
	ExpiresAt     string `json:"expiresAt"`
	Instruction   string `json:"instruction"`
}

type completionResult struct {
	Status        string                `json:"status"`
	ResultCode    string                `json:"resultCode"`
	Summary       string                `json:"summary"`
	DurationMs    int64                 `json:"durationMs"`
	ExitCode      *int                  `json:"exitCode,omitempty"`
	TestNG        *testNGResultSummary  `json:"testNg,omitempty"`
	LogWatermarks *logWatermark         `json:"logWatermarks,omitempty"`
	Artifacts     []artifactDeclaration `json:"artifacts,omitempty"`
}

type testNGResultSummary struct {
	testNGResultCounts
	DetailsTruncated bool                `json:"detailsTruncated"`
	Suites           []testNGSuiteResult `json:"suites"`
}

type testNGResultCounts struct {
	Total                 int `json:"total"`
	Passed                int `json:"passed"`
	Failed                int `json:"failed"`
	Skipped               int `json:"skipped"`
	ConfigurationFailures int `json:"configurationFailures"`
}

type testNGSuiteResult struct {
	testNGResultCounts
	Name       string             `json:"name"`
	DurationMs int64              `json:"durationMs"`
	Tests      []testNGTestResult `json:"tests"`
}

type testNGTestResult struct {
	testNGResultCounts
	Name       string              `json:"name"`
	DurationMs int64               `json:"durationMs"`
	Classes    []testNGClassResult `json:"classes"`
}

type testNGClassResult struct {
	testNGResultCounts
	Name       string               `json:"name"`
	DurationMs int64                `json:"durationMs"`
	Methods    []testNGMethodResult `json:"methods"`
}

type testNGMethodResult struct {
	Name          string `json:"name"`
	Signature     string `json:"signature,omitempty"`
	Status        string `json:"status"`
	Configuration bool   `json:"configuration"`
	DurationMs    int64  `json:"durationMs"`
}

type artifactDeclaration struct {
	ArtifactID   string `json:"artifactId"`
	RelativePath string `json:"relativePath"`
	MediaType    string `json:"mediaType"`
	SizeBytes    int64  `json:"sizeBytes"`
	SHA256       string `json:"sha256"`
	Required     bool   `json:"required"`
}

type declareArtifactsRequest struct {
	SchemaVersion int                   `json:"schemaVersion"`
	RequestID     string                `json:"requestId"`
	LeaseToken    string                `json:"leaseToken"`
	Artifacts     []artifactDeclaration `json:"artifacts"`
}

type declaredArtifact struct {
	artifactDeclaration
	UploadPath   string `json:"uploadPath"`
	UploadMethod string `json:"uploadMethod"`
	FinalizePath string `json:"finalizePath,omitempty"`
	Status       string `json:"status"`
}

type declareArtifactsResponse struct {
	SchemaVersion int                `json:"schemaVersion"`
	Artifacts     []declaredArtifact `json:"artifacts"`
}

type uploadArtifactResponse struct {
	ArtifactID string `json:"artifactId"`
	Status     string `json:"status"`
}

type logChunk struct {
	Stream     string `json:"stream"`
	Sequence   int64  `json:"sequence"`
	Content    string `json:"content"`
	RecordedAt string `json:"recordedAt"`
}

type logWatermark struct {
	Stdout int64 `json:"stdout"`
	Stderr int64 `json:"stderr"`
	Agent  int64 `json:"agent"`
}

type uploadLogChunksRequest struct {
	SchemaVersion int        `json:"schemaVersion"`
	RequestID     string     `json:"requestId"`
	LeaseToken    string     `json:"leaseToken"`
	Chunks        []logChunk `json:"chunks"`
}

type uploadLogChunksResponse struct {
	SchemaVersion        int          `json:"schemaVersion"`
	AcknowledgedSequence logWatermark `json:"acknowledgedSequence"`
}

type completeAttemptRequest struct {
	SchemaVersion int              `json:"schemaVersion"`
	CompletionID  string           `json:"completionId"`
	LeaseToken    string           `json:"leaseToken"`
	Result        completionResult `json:"result"`
}

type CompleteAttemptResponse struct {
	SchemaVersion  int    `json:"schemaVersion"`
	CompletionID   string `json:"completionId"`
	AcceptedAt     string `json:"acceptedAt"`
	Disposition    string `json:"disposition"`
	RetryScheduled bool   `json:"retryScheduled"`
}

type localAttempt struct {
	AttemptID    string `json:"attemptId"`
	LeaseID      string `json:"leaseId,omitempty"`
	LeaseVersion int    `json:"leaseVersion,omitempty"`
	LocalState   string `json:"localState"`
}

type reconcileRequest struct {
	SchemaVersion int            `json:"schemaVersion"`
	RequestID     string         `json:"requestId"`
	Attempts      []localAttempt `json:"attempts"`
}

type ReconcileDecision struct {
	AttemptID               string        `json:"attemptId"`
	Action                  string        `json:"action"`
	AcknowledgedLogSequence *logWatermark `json:"acknowledgedLogSequence,omitempty"`
}

type ReconcileResponse struct {
	SchemaVersion int                 `json:"schemaVersion"`
	Decisions     []ReconcileDecision `json:"decisions"`
}
