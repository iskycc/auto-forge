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
		err = runDoctor(stdout)
	case "run-once":
		err = runOnce(arguments[1:], stdout, stderr)
	case "start":
		err = runAgent(stdout, info)
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

func runAgent(diagnostics io.Writer, info buildinfo.Info) error {
	configuration, err := config.Load(os.LookupEnv)
	if err != nil {
		return fmt.Errorf("load configuration: %w", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return control.Run(ctx, configuration, info, diagnostics)
}

func runDoctor(stdout io.Writer) error {
	configuration, err := config.Load(os.LookupEnv)
	if err != nil {
		return fmt.Errorf("load configuration: %w", err)
	}
	diagnostic, err := config.CheckLocalEnvironment(configuration)
	if err != nil {
		return err
	}
	return writeJSON(stdout, diagnostic)
}

func runOnce(arguments []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("run-once", flag.ContinueOnError)
	flags.SetOutput(stderr)
	specPath := flags.String("spec", "", "path to a schemaVersion 1 execution spec")
	dataDirectory := flags.String("data-dir", "", "agent data directory")
	keepWorkspace := flags.Bool("keep-workspace", false, "retain the attempt workspace after execution")
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
	fmt.Fprintln(writer, "  doctor     Validate local configuration and writable directories")
	fmt.Fprintln(writer, "  run-once   Execute one local versioned spec without a shell")
	fmt.Fprintln(writer, "  start      Register, reconcile, claim and execute control-plane assignments")
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
