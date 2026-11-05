import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failureLogEntryName, prepareFailureLogArchive } from "./failure-log-archive";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "failure-log-zip-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
async function* text(value: string) {
  yield value;
}

describe("failure log ZIP", () => {
  it("streams complete UTF-8 logs with safe unique class paths and DDT CaseIDs", async () => {
    const names = [
      failureLogEntryName("com.example.WalletTest", 1, 1),
      failureLogEntryName("../中文:Case/CON", 2, 2),
    ];
    const long = `\ufeff中文😀\n${"完整堆栈\n".repeat(10000)}`;
    async function* entries() {
      yield { name: names[0]!, content: text(long) };
      yield { name: names[1]!, content: text("other") };
    }
    const prepared = await prepareFailureLogArchive(entries(), signal(), directory);
    try {
      const bytes = Buffer.alloc(prepared.sizeBytes);
      await prepared.file.read(bytes, 0, bytes.length, 0);
      const archive = unzipSync(bytes);
      expect(Object.keys(archive)).toEqual(names);
      expect(Buffer.from(archive[names[0]!]!).toString("utf8")).toBe(long);
      expect(Buffer.from(archive[names[1]!]!).toString("utf8")).toBe("other");
      for (const name of names) expect(name).not.toMatch(/[\\/:]/u);
      expect(names[0]).toMatch(/^com\.example\.WalletTest.*\.log$/u);
    } finally {
      await prepared.file.close();
    }
  });

  it("cancels without visiting later files and closes temporary output on errors", async () => {
    const controller = new AbortController();
    let visited = 0;
    async function* entries() {
      visited++;
      yield {
        name: "first.log",
        content: (async function* () {
          yield "a";
          controller.abort(new Error("cancelled"));
          yield "b";
        })(),
      };
      visited++;
      yield { name: "second.log", content: text("later") };
    }
    await expect(prepareFailureLogArchive(entries(), controller.signal, directory)).rejects.toThrow(
      "cancelled",
    );
    expect(visited).toBe(1);
    await expect(
      prepareFailureLogArchive(
        (async function* () {
          yield {
            name: "bad.log",
            content: (async function* () {
              yield await Promise.reject(new Error("读取日志失败"));
            })(),
          };
        })(),
        signal(),
        directory,
      ),
    ).rejects.toThrow("读取日志失败");
  });

  it("bounds names and prevents collisions or path traversal", () => {
    expect(failureLogEntryName("../CON", 1, 1)).not.toMatch(/^(?:CON|\.\.)[.\\/]/iu);
    const a = failureLogEntryName("中文😀".repeat(200), 1, 1);
    expect(Buffer.byteLength(a)).toBeLessThanOrEqual(240);
    expect(a).not.toContain("�");
    expect(failureLogEntryName("same", 1, 1)).not.toBe(failureLogEntryName("same", 1, 2));
  });
});
