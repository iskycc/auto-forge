import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProcessExecutor } from "../src/process-executor";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function executor(): Promise<ProcessExecutor> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "autoforge-executor-"));
  temporaryDirectories.push(workspaceRoot);
  return new ProcessExecutor({ workspaceRoot, allowedExecutables: [process.execPath] });
}

describe("ProcessExecutor", () => {
  it("executes an allowed command without a shell and captures separate streams", async () => {
    const processExecutor = await executor();
    const result = await processExecutor.execute({
      executable: process.execPath,
      arguments: ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
      workingDirectory: "attempt-1",
      timeoutMs: 5_000,
      maximumOutputBytes: 1_024,
    });

    expect(result).toMatchObject({ exitCode: 0, timedOut: false, outputLimitExceeded: false });
    expect(new TextDecoder().decode(result.stdout)).toBe("out");
    expect(new TextDecoder().decode(result.stderr)).toBe("err");
  });

  it("rejects executable and working-directory escapes", async () => {
    const processExecutor = await executor();
    await expect(
      processExecutor.execute({
        executable: "/bin/sh",
        arguments: [],
        workingDirectory: "attempt-1",
        timeoutMs: 1_000,
        maximumOutputBytes: 1_024,
      }),
    ).rejects.toThrow("not allowed");
    await expect(
      processExecutor.execute({
        executable: process.execPath,
        arguments: [],
        workingDirectory: "../escape",
        timeoutMs: 1_000,
        maximumOutputBytes: 1_024,
      }),
    ).rejects.toThrow("contained relative path");
  });

  it("terminates commands that exceed the output limit", async () => {
    const processExecutor = await executor();
    const result = await processExecutor.execute({
      executable: process.execPath,
      arguments: ["-e", "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000)"],
      workingDirectory: "attempt-2",
      timeoutMs: 5_000,
      maximumOutputBytes: 128,
    });

    expect(result.outputLimitExceeded).toBe(true);
    expect(result.stdout.byteLength + result.stderr.byteLength).toBe(128);
  });

  it("terminates the process group after a bounded timeout", async () => {
    const processExecutor = await executor();
    const result = await processExecutor.execute({
      executable: process.execPath,
      arguments: ["-e", "setInterval(() => {}, 1000)"],
      workingDirectory: "attempt-timeout",
      timeoutMs: 25,
      maximumOutputBytes: 1_024,
    });

    expect(result).toMatchObject({ timedOut: true, cancelled: false });
    expect(result.signal).toBe("SIGTERM");
  });

  it("honors cancellation without reporting a timeout", async () => {
    const processExecutor = await executor();
    const controller = new AbortController();
    const completion = processExecutor.execute({
      executable: process.execPath,
      arguments: ["-e", "setInterval(() => {}, 1000)"],
      workingDirectory: "attempt-cancelled",
      timeoutMs: 5_000,
      maximumOutputBytes: 1_024,
      signal: controller.signal,
    });
    controller.abort();

    await expect(completion).resolves.toMatchObject({ timedOut: false, cancelled: true });
  });
});
