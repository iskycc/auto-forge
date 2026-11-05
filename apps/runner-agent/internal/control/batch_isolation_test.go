package control

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// Identical archive names and input IDs across versions must never select another batch's bytes.
func TestConcurrentVersionsKeepJDKDependenciesAndAttemptOutputsSeparate(t *testing.T) {
	type versionFixture struct {
		inputs []ExecutionInput
		bytes  map[string][]byte
	}
	versions := make(map[string]versionFixture)
	for _, version := range []string{"jdk8", "jdk21"} {
		directory := t.TempDir()
		archives := map[string]map[string]string{
			"jdk":    {"jdk/bin/java": version, "jdk/release": "JAVA_VERSION=" + version},
			"bundle": {"lib/dependency.jar": "dependency-" + version},
		}
		contents := map[string][]byte{"tests": []byte("test-" + version)}
		for name, files := range archives {
			path := filepath.Join(directory, name+".zip")
			writeZipFixture(t, path, files)
			content, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			contents[name] = content
		}
		versions[version] = versionFixture{bytes: contents, inputs: []ExecutionInput{
			executionInputFixture("tests", "test-jar", "inputs/test.jar", contents["tests"]),
			executionInputFixture("jdk", "jdk-archive", "runtime-inputs/jdk.zip", contents["jdk"]),
			executionInputFixture("bundle", "jar-bundle", "runtime-inputs/dependencies.zip", contents["bundle"]),
		}}
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		for version, fixture := range versions {
			if !strings.Contains(request.URL.Path, "/attempt-"+version+"-") {
				continue
			}
			for inputID, content := range fixture.bytes {
				if strings.HasSuffix(request.URL.Path, "/inputs/"+inputID) {
					writer.Header().Set("Content-Length", fmt.Sprint(len(content)))
					_, _ = writer.Write(content)
					return
				}
			}
		}
		http.NotFound(writer, request)
	}))
	defer server.Close()
	client, err := NewClient(testConfiguration(t, server.URL))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	registry := newBatchRegistry(t.TempDir())
	identity := Identity{RunnerID: "runner-1", Credential: "runner-credential"}
	type slot struct{ version, attemptID, workspace string }
	var slots []slot
	for version := range versions {
		for index := range 2 {
			if err := registry.acquire("batch-" + version); err != nil {
				t.Fatal(err)
			}
			slots = append(slots, slot{version, fmt.Sprintf("attempt-%s-%d", version, index), t.TempDir()})
		}
	}
	var workers sync.WaitGroup
	failures := make(chan error, len(slots))
	for _, slot := range slots {
		workers.Go(func() {
			fixture := versions[slot.version]
			claimed := batchClaimedAssignment(slot.attemptID, "batch-"+slot.version, fixture.inputs[0])
			claimed.Assignment.ExecutionSpec.Inputs = fixture.inputs
			shared, err := registry.ensureBatchInputs(context.Background(), client, identity, claimed, fixture.inputs, true)
			if err == nil {
				err = linkBatchInputsIntoWorkspace(shared, slot.workspace, fixture.inputs)
			}
			if err == nil {
				err = linkSharedCotestRuntime(shared, slot.workspace, fixture.inputs)
			}
			if err == nil {
				err = os.MkdirAll(filepath.Join(slot.workspace, "reports"), 0o700)
			}
			if err == nil {
				err = os.WriteFile(filepath.Join(slot.workspace, "reports", "result.txt"), []byte(slot.attemptID), 0o600)
			}
			failures <- err
		})
	}
	workers.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, slot := range slots {
		for relative, expected := range map[string]string{
			"runtime/jdk/bin/java":         slot.version,
			"test-jars/lib/dependency.jar": "dependency-" + slot.version,
			"inputs/test.jar":              "test-" + slot.version,
			"reports/result.txt":           slot.attemptID,
		} {
			actual, err := os.ReadFile(filepath.Join(slot.workspace, filepath.FromSlash(relative)))
			if err != nil || string(actual) != expected {
				t.Fatalf("%s %s = %q, %v; want %q", slot.attemptID, relative, actual, err, expected)
			}
		}
	}
	// Closing one version cannot remove the other version's linked runtime.
	registry.release("batch-jdk8", true, nil)
	registry.release("batch-jdk8", true, nil)
	if _, err := os.Stat(registry.directory("batch-jdk8")); !os.IsNotExist(err) {
		t.Fatalf("closed batch directory: %v", err)
	}
	for _, slot := range slots {
		if slot.version == "jdk21" {
			if actual, err := os.ReadFile(filepath.Join(slot.workspace, "runtime/jdk/bin/java")); err != nil || string(actual) != "jdk21" {
				t.Fatalf("other version runtime lost after cleanup: %q %v", actual, err)
			}
		}
	}
}
