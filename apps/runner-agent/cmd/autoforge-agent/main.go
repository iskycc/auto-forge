package main

import (
	"os"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/buildinfo"
	"github.com/iskycc/auto-forge/apps/runner-agent/internal/cli"
)

var (
	version   = "dev"
	commit    = "unknown"
	buildDate = "unknown"
	variant   = "development"
)

func main() {
	info := buildinfo.Info{
		Version:   version,
		Commit:    commit,
		BuildDate: buildDate,
		Variant:   variant,
	}
	os.Exit(cli.Run(os.Args[1:], os.Stdout, os.Stderr, info))
}
