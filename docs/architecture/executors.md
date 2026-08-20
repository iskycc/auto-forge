# Executor boundary

AutoForge keeps command lifecycle policy behind an executor boundary. The production Runner Agent
uses the Go implementation in `apps/runner-agent/internal/executor`; the TypeScript
`@autoforge/executors` package provides the same parameterized-process primitive for control-plane
and offline tooling without importing queue, database, object-store, or web concerns.

The TypeScript process executor currently enforces these concrete boundaries:

- the composition root supplies an explicit executable allowlist;
- arguments are passed as an array with `shell: false`, with count, byte, and NUL limits;
- each working directory is relative to a configured absolute workspace root and is checked again
  after `realpath` resolution;
- stdout and stderr are captured separately under one combined byte limit;
- timeout, cancellation, or output exhaustion terminates the Linux process group, followed by a
  bounded `SIGKILL` grace period;
- environment names, values, and entry count are bounded.

This boundary is process supervision, not a complete sandbox. It does not by itself isolate the
network, kernel, mount namespace, user namespace, or filesystem outside the working directory.
Production test execution should use the Runner Agent's cgroup v2/rlimit controls and host hardening
described in the Runner threat model. A no-cgroup mode is available for trusted internal hosts; it
retains rlimits, process-group cleanup, timeouts and workspace monitoring, but does not provide hard
CPU, memory or descendant-process-count isolation.

## Container executor

The Go Runner Agent also supports the opt-in `testng-container` executor. It is advertised only
when the Agent configuration supplies all of the following: an allowlisted OCI runtime
(`docker`, `podman`, or `nerdctl`), an immutable `@sha256:` image reference, an existing seccomp
profile, a numeric non-root user, and the Java/TestNG paths inside that image. The scheduler then
requires the `executor:testng-container-v1` capability before creating an assignment.

For every attempt the Agent invokes the runtime directly with an argument array and applies these
concrete restrictions:

- network mode `none`, a read-only root filesystem, `no-new-privileges`, all Linux capabilities
  dropped, and the configured seccomp profile;
- a numeric non-root user, bounded pids/memory/CPU and a bounded `/tmp` tmpfs;
- exactly one read-write bind mount: the attempt workspace, mounted at `/workspace`;
- a minimal fixed process environment; new execution tasks cannot inject platform-managed secrets
  or arbitrary environment variables into the container;
- the same cgroup/process-group cancellation, log spool, result mapping, artifact validation and
  cleanup lifecycle used by the process executor.

This is defense in depth, not a complete sandbox. The container still shares the Runner host
kernel and the security outcome depends on the selected runtime, seccomp policy, daemon
configuration and host patch level. Rootless runtime operation and a dedicated, hardened Runner
host are recommended for untrusted test code. The local Agent policy can disable the capability or
pin a stricter image/profile; the control plane cannot relax those choices.
