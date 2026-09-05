import { access, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";

export async function distributedFault(
  operation: "primary.stop" | "primary.start" | "redis.restart",
) {
  const directory = process.env.E2E_DISTRIBUTED_FAULT_DIR;
  if (!directory)
    throw new Error("The distributed fault controller is required for this acceptance.");
  const completion = {
    "primary.stop": "primary.stopped",
    "primary.start": "primary.started",
    "redis.restart": "redis.restarted",
  }[operation];
  await rm(join(directory, completion), { force: true });
  await writeFile(join(directory, operation), "requested\n");
  await expect
    .poll(
      async () => {
        try {
          await access(join(directory, completion));
          return true;
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
          throw error;
        }
      },
      { timeout: 60_000, message: `Fault controller did not complete ${operation}` },
    )
    .toBe(true);
}
