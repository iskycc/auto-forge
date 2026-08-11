import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

const MAX_ARGUMENTS = 1_024;
const MAX_ARGUMENT_BYTES = 64 * 1_024;
const MAX_ENVIRONMENT_ENTRIES = 256;
const TERMINATION_GRACE_MS = 2_000;

export type ProcessExecutionRequest = {
  executable: string;
  arguments: string[];
  workingDirectory: string;
  environment?: Record<string, string>;
  timeoutMs: number;
  maximumOutputBytes: number;
  signal?: AbortSignal;
};

export type ProcessExecutionResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
  timedOut: boolean;
  cancelled: boolean;
  outputLimitExceeded: boolean;
};

export type ProcessExecutorOptions = {
  workspaceRoot: string;
  allowedExecutables: readonly string[];
};

type OutputAccumulator = {
  chunks: Uint8Array[];
  size: number;
};

type CapturedProcess = ChildProcessByStdio<null, Readable, Readable>;

export class ProcessExecutor {
  private readonly workspaceRoot: string;
  private readonly allowedExecutables: ReadonlySet<string>;

  constructor(options: ProcessExecutorOptions) {
    if (!path.isAbsolute(options.workspaceRoot)) {
      throw new Error("ProcessExecutor workspaceRoot must be absolute.");
    }
    if (options.allowedExecutables.length === 0) {
      throw new Error("ProcessExecutor requires at least one allowed executable.");
    }
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.allowedExecutables = new Set(options.allowedExecutables);
  }

  async execute(request: ProcessExecutionRequest): Promise<ProcessExecutionResult> {
    validateRequest(request, this.allowedExecutables);
    const workingDirectory = await this.resolveWorkingDirectory(request.workingDirectory);
    const child = spawn(request.executable, request.arguments, {
      cwd: workingDirectory,
      detached: true,
      env: { ...process.env, ...request.environment },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return collectProcess(child, request);
  }

  private async resolveWorkingDirectory(relativeDirectory: string): Promise<string> {
    if (
      !relativeDirectory ||
      path.isAbsolute(relativeDirectory) ||
      relativeDirectory.split(/[\\/]/).some((segment) => segment === "..")
    ) {
      throw new Error("Process workingDirectory must be a contained relative path.");
    }
    const requested = path.resolve(this.workspaceRoot, relativeDirectory);
    if (!isContained(this.workspaceRoot, requested)) {
      throw new Error("Process workingDirectory escapes the workspace root.");
    }
    await mkdir(requested, { recursive: true, mode: 0o700 });
    const [root, resolved] = await Promise.all([realpath(this.workspaceRoot), realpath(requested)]);
    if (!isContained(root, resolved)) {
      throw new Error("Process workingDirectory resolves outside the workspace root.");
    }
    return resolved;
  }
}

function validateRequest(
  request: ProcessExecutionRequest,
  allowedExecutables: ReadonlySet<string>,
): void {
  if (!allowedExecutables.has(request.executable)) {
    throw new Error(`Executable is not allowed: ${request.executable}`);
  }
  if (request.arguments.length > MAX_ARGUMENTS) {
    throw new Error(`Process arguments exceed ${MAX_ARGUMENTS} entries.`);
  }
  const argumentBytes = request.arguments.reduce((total, argument) => {
    if (argument.includes("\0")) throw new Error("Process arguments cannot contain NUL bytes.");
    return total + Buffer.byteLength(argument);
  }, 0);
  if (argumentBytes > MAX_ARGUMENT_BYTES) {
    throw new Error(`Process arguments exceed ${MAX_ARGUMENT_BYTES} bytes.`);
  }
  if (
    !Number.isInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    request.timeoutMs > 86_400_000
  ) {
    throw new Error("Process timeoutMs is outside the supported range.");
  }
  if (
    !Number.isInteger(request.maximumOutputBytes) ||
    request.maximumOutputBytes < 1 ||
    request.maximumOutputBytes > 10 * 1024 * 1024 * 1024
  ) {
    throw new Error("Process maximumOutputBytes is outside the supported range.");
  }
  const environment = Object.entries(request.environment ?? {});
  if (environment.length > MAX_ENVIRONMENT_ENTRIES) {
    throw new Error(`Process environment exceeds ${MAX_ENVIRONMENT_ENTRIES} entries.`);
  }
  for (const [name, value] of environment) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || value.includes("\0")) {
      throw new Error(`Process environment entry is invalid: ${name}`);
    }
  }
}

async function collectProcess(
  child: CapturedProcess,
  request: ProcessExecutionRequest,
): Promise<ProcessExecutionResult> {
  const stdout: OutputAccumulator = { chunks: [], size: 0 };
  const stderr: OutputAccumulator = { chunks: [], size: 0 };
  let timedOut = false;
  let cancelled = false;
  let outputLimitExceeded = false;
  let terminating = false;

  const terminate = (): void => {
    if (terminating || child.exitCode !== null || child.signalCode !== null) return;
    terminating = true;
    signalProcessGroup(child, "SIGTERM");
    const forceTimer = setTimeout(() => signalProcessGroup(child, "SIGKILL"), TERMINATION_GRACE_MS);
    forceTimer.unref();
  };
  const append = (accumulator: OutputAccumulator, chunk: Buffer): void => {
    const remaining = request.maximumOutputBytes - stdout.size - stderr.size;
    if (remaining <= 0) {
      outputLimitExceeded = true;
      terminate();
      return;
    }
    const accepted = chunk.subarray(0, remaining);
    accumulator.chunks.push(accepted);
    accumulator.size += accepted.byteLength;
    if (accepted.byteLength < chunk.byteLength) {
      outputLimitExceeded = true;
      terminate();
    }
  };
  child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
  child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));

  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, request.timeoutMs);
  timeout.unref();
  const abort = (): void => {
    cancelled = true;
    terminate();
  };
  request.signal?.addEventListener("abort", abort, { once: true });
  if (request.signal?.aborted) abort();

  try {
    const completion = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    return {
      ...completion,
      stdout: Buffer.concat(stdout.chunks, stdout.size),
      stderr: Buffer.concat(stderr.chunks, stderr.size),
      timedOut,
      cancelled,
      outputLimitExceeded,
    };
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", abort);
  }
}

function signalProcessGroup(child: CapturedProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") child.kill(signal);
  }
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
