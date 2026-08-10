package main

import (
	"fmt"
	"os"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/buildinfo"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/cli"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/executor"
)

var (
	version   = "dev"
	commit    = "unknown"
	buildDate = "unknown"
	variant   = "development"
)

func main() {
	if executor.IsResourceWrapper(os.Args[1:]) {
		if err := executor.RunResourceWrapper(os.Args[1:]); err != nil {
			fmt.Fprintf(os.Stderr, "autoforge resource setup: %v\n", err)
			os.Exit(125)
		}
		return
	}
	info := buildinfo.Info{
		Version:   version,
		Commit:    commit,
		BuildDate: buildDate,
		Variant:   variant,
	}
	os.Exit(cli.Run(os.Args[1:], os.Stdout, os.Stderr, info))
}
