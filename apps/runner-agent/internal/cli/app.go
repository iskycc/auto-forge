package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/buildinfo"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/config"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/control"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/executor"
)

const (
	exitSuccess = 0
	exitFailure = 1
	exitUsage   = 2
)

func Run(arguments []string, stdout, stderr io.Writer, info buildinfo.Info) int {
	if len(arguments) == 0 {
		printUsage(stderr)
		return exitUsage
	}

	var err error
	switch arguments[0] {
	case "version":
		err = writeJSON(stdout, info.Details())
	case "doctor":
		err = runDoctor(arguments[1:], stdout, stderr)
	case "health":
		err = runHealth(arguments[1:], stdout, stderr)
	case "run-once":
		err = runOnce(arguments[1:], stdout, stderr)
	case "rotate-credential":
		err = rotateCredential(arguments[1:], stdout, stderr)
	case "start":
		err = runAgent(arguments[1:], stdout, stderr, info)
	case "help", "-h", "--help":
		printUsage(stdout)
		return exitSuccess
	default:
		fmt.Fprintf(stderr, "unknown command %q\n", arguments[0])
		printUsage(stderr)
		return exitUsage
	}
	if err != nil {
		fmt.Fprintf(stderr, "autoforge-agent: %v\n", err)
		return exitFailure
	}
	return exitSuccess
}

func runHealth(arguments []string, stdout, stderr io.Writer) error {
	if len(arguments) == 0 {
		return errors.New("health requires live or ready")
	}
	switch arguments[0] {
	case "live":
		if len(arguments) != 1 {
			return errors.New("health live does not accept configuration arguments")
		}
		return writeJSON(stdout, struct {
			Status string `json:"status"`
		}{Status: "live"})
	case "ready":
		configuration, err := loadConfiguration(arguments[1:], stderr)
		if err != nil {
			return fmt.Errorf("load configuration: %w", err)
		}
		diagnostic, err := config.CheckLocalEnvironment(configuration)
		if err != nil {
			return err
		}
		return writeJSON(stdout, diagnostic)
	default:
		return errors.New("health requires live or ready")
	}
}

func runAgent(arguments []string, diagnostics, stderr io.Writer, info buildinfo.Info) error {
	configuration, err := loadConfiguration(arguments, stderr)
	if err != nil {
		return fmt.Errorf("load configuration: %w", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return control.Run(ctx, configuration, info, diagnostics)
}

func runDoctor(arguments []string, stdout, stderr io.Writer) error {
	configuration, err := loadConfiguration(arguments, stderr)
	if err != nil {
		return fmt.Errorf("load configuration: %w", err)
	}
	diagnostic, err := config.CheckLocalEnvironment(configuration)
	if err != nil {
		return err
	}
	return writeJSON(stdout, diagnostic)
}

func rotateCredential(arguments []string, stdout, stderr io.Writer) error {
	configuration, err := loadConfiguration(arguments, stderr)
	if err != nil {
		return fmt.Errorf("load configuration: %w", err)
	}
	store := control.NewIdentityStore(configuration.DataDirectory)
	identity, found, err := store.Load()
	if err != nil {
		return err
	}
	if !found {
		return errors.New("runner is not registered; start the agent once before rotating its credential")
	}
	client, err := control.NewClient(configuration)
	if err != nil {
		return err
	}
	defer client.Close()
	rotated, err := client.RotateCredential(context.Background(), identity)
	if err != nil {
		return err
	}
	if err := store.Save(rotated); err != nil {
		return fmt.Errorf("persist rotated identity (the previous credential remains valid briefly; retry the command): %w", err)
	}
	return writeJSON(stdout, struct {
		RunnerID string `json:"runnerId"`
		Rotated  bool   `json:"rotated"`
	}{RunnerID: rotated.RunnerID, Rotated: true})
}

func loadConfiguration(arguments []string, stderr io.Writer) (config.Config, error) {
	flags := flag.NewFlagSet("Agent configuration", flag.ContinueOnError)
	flags.SetOutput(stderr)
	configurationPath := flags.String("config", "", "path to a private schemaVersion 1 JSON configuration")
	if err := flags.Parse(arguments); err != nil {
		return config.Config{}, err
	}
	if flags.NArg() != 0 {
		return config.Config{}, errors.New("unexpected positional Agent configuration arguments")
	}
	if *configurationPath != "" {
		return config.LoadFile(*configurationPath)
	}
	return config.Load(os.LookupEnv)
}

func runOnce(arguments []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("run-once", flag.ContinueOnError)
	flags.SetOutput(stderr)
	specPath := flags.String("spec", "", "path to a schemaVersion 1 execution spec")
	dataDirectory := flags.String("data-dir", "", "agent data directory")
	keepWorkspace := flags.Bool("keep-workspace", false, "retain the attempt workspace after execution")
	cgroupRoot := flags.String("cgroup-root", "", "delegated cgroup v2 root for resource enforcement")
	allowedExecutables := stringListFlag{}
	flags.Var(&allowedExecutables, "allow-executable", "exact executable allowed by local policy; repeatable")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("run-once does not accept positional arguments")
	}
	if *specPath == "" || *dataDirectory == "" || len(allowedExecutables) == 0 {
		return errors.New("run-once requires --spec, --data-dir and at least one --allow-executable")
	}

	absoluteDataDirectory, err := filepath.Abs(*dataDirectory)
	if err != nil {
		return fmt.Errorf("resolve data directory: %w", err)
	}
	spec, err := executor.ReadSpec(*specPath)
	if err != nil {
		return err
	}
	result, err := executor.Run(context.Background(), spec, executor.RunOptions{
		DataDirectory: absoluteDataDirectory,
		KeepWorkspace: *keepWorkspace,
		Policy: executor.Policy{
			AllowedExecutables: allowedExecutables,
		},
		ResourcePolicy: executor.ResourcePolicy{
			CgroupRoot:    *cgroupRoot,
			RequireCgroup: *cgroupRoot != "",
		},
	})
	if err != nil {
		return err
	}
	if err := writeJSON(stdout, result); err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("executed process exited with code %d", result.ExitCode)
	}
	return nil
}

func writeJSON(writer io.Writer, value any) error {
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return fmt.Errorf("write JSON output: %w", err)
	}
	return nil
}

func printUsage(writer io.Writer) {
	fmt.Fprintln(writer, "Usage: autoforge-agent <command>")
	fmt.Fprintln(writer, "")
	fmt.Fprintln(writer, "Commands:")
	fmt.Fprintln(writer, "  version    Print build and target information as JSON")
	fmt.Fprintln(writer, "  doctor     Validate local configuration and writable directories [--config FILE]")
	fmt.Fprintln(writer, "  health     Probe liveness or local readiness: health live|ready [--config FILE]")
	fmt.Fprintln(writer, "  run-once   Execute one local versioned spec without a shell")
	fmt.Fprintln(writer, "  rotate-credential  Exchange the runner credential for a newly issued one [--config FILE]")
	fmt.Fprintln(writer, "  start      Register, reconcile, claim and execute assignments [--config FILE]")
}

type stringListFlag []string

func (values *stringListFlag) String() string {
	return fmt.Sprintf("%v", []string(*values))
}

func (values *stringListFlag) Set(value string) error {
	if value == "" {
		return errors.New("allowed executable must not be empty")
	}
	*values = append(*values, value)
	return nil
}
