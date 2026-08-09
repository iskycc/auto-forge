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

type ResourceLimits struct {
	CPUMillicores int64 `json:"cpuMillicores"`
	MemoryBytes   int64 `json:"memoryBytes"`
	DiskBytes     int64 `json:"diskBytes"`
	ProcessCount  int64 `json:"processCount"`
	LogBytes      int64 `json:"logBytes"`
	ArtifactBytes int64 `json:"artifactBytes"`
}

type ExecutionSpec struct {
	SchemaVersion        int                `json:"schemaVersion"`
	Executor             string             `json:"executor"`
	AttemptID            string             `json:"attemptId"`
	ExecutionRunID       string             `json:"executionRunId"`
	BatchID              string             `json:"batchId"`
	ClassName            string             `json:"className"`
	MethodDescriptors    []string           `json:"methodDescriptors"`
	Inputs               []ExecutionInput   `json:"inputs"`
	Environment          []EnvironmentEntry `json:"environment"`
	RequiredLabels       []string           `json:"requiredLabels"`
	RequiredCapabilities []string           `json:"requiredCapabilities"`
	TimeoutMs            int64              `json:"timeoutMs"`
	UploadTimeoutMs      int64              `json:"uploadTimeoutMs"`
	ResourceLimits       ResourceLimits     `json:"resourceLimits"`
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
	Status     string `json:"status"`
	ResultCode string `json:"resultCode"`
	Summary    string `json:"summary"`
	DurationMs int64  `json:"durationMs"`
	ExitCode   *int   `json:"exitCode,omitempty"`
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
	AttemptID string `json:"attemptId"`
	Action    string `json:"action"`
}

type ReconcileResponse struct {
	SchemaVersion int                 `json:"schemaVersion"`
	Decisions     []ReconcileDecision `json:"decisions"`
}
