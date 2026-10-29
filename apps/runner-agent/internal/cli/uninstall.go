package cli

import (
	"context"
	"errors"
	"flag"
	"io"
	"os"
	"os/exec"
	"time"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/installation"
)

func uninstallAgent(arguments []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("uninstall", flag.ContinueOnError)
	flags.SetOutput(stderr)
	inspect := flags.Bool("inspect", false, "verify the installation and print its data directory without changing anything")
	confirmed := flags.Bool("confirm", false, "permanently remove the system Agent and its local execution data")
	expectedID := flags.String("expected-runner-id", "", "refuse to uninstall a different Runner identity")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("uninstall does not accept positional arguments")
	}
	if !*inspect && !*confirmed {
		return errors.New("uninstall requires --confirm; this permanently removes local credentials, workspaces, logs and caches")
	}
	if os.Geteuid() != 0 {
		return errors.New("uninstall must run as root")
	}
	manager := installation.Uninstaller{Layout: installation.SystemLayout(), RunCommand: func(ctx context.Context, name string, args ...string) ([]byte, error) {
		return exec.CommandContext(ctx, name, args...).CombinedOutput()
	}}
	if *inspect {
		plan, err := manager.Inspect(*expectedID)
		if err != nil {
			return err
		}
		return writeJSON(stdout, plan)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	result, err := manager.Execute(ctx, *expectedID)
	if err != nil {
		return err
	}
	return writeJSON(stdout, result)
}
