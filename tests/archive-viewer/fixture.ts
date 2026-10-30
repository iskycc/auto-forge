import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  LogArchiveAttempt,
  LogArchiveManifest,
  LogArchiveStreamIndex,
} from "@autoforge/contracts";
import {
  encodeArchiveFrame,
  hashArchiveChunk,
  type ArchivedLogChunk,
} from "../../packages/db/src/log-archive-codec";

export async function writeViewerFixture(directory: string) {
  const batchId = "batch-wallet",
    now = "2026-10-30T00:00:00.000Z";
  const location = join(directory, "batches", batchId);
  await mkdir(location, { recursive: true });
  const logs: Buffer[] = [],
    descriptors: Buffer[] = [],
    attempts: LogArchiveAttempt[] = [];
  let logOffset = 0,
    indexOffset = 0,
    chunkCount = 0,
    rawBytes = 0;
  for (let number = 0; number < 61; number++) {
    const id = `attempt-${String(number).padStart(3, "0")}`;
    const streams = {} as Record<"stdout" | "stderr" | "agent", LogArchiveStreamIndex>;
    for (const stream of ["stdout", "stderr", "agent"] as const) {
      let contents: string[] = [];
      if (stream === "stdout")
        contents =
          number === 0
            ? [
                "\u001b[31;1mERROR 红色失败：钱包中文🚀\u001b[0m\r\nINFO 普通信息\n\u001b]8;;https://evil.invalid\u0007链接文本\u001b]8;;\u0007\n<img src=x onerror=alert(1)>\nTestCase Run Failed Stack Base64: [c2VjcmV0]\n",
                ...Array.from({ length: 98 }, (_, i) => `INFO 中文日志-${i + 2}\n`),
                "WARN 跨页颜色\u001b[3",
                "2m绿色继续：第101块\u001b[0m\n",
                ...Array.from(
                  { length: 3 },
                  (_, i) => `大日志分段${i + 1}：` + "Wallet 中文长行🚀 ".repeat(10000) + "\n",
                ),
              ]
            : [`用例 ${number + 1} 的独立日志，不继承其他用例页码。\n`];
      if (stream === "stderr") contents = ["\u001b[33mWARN stderr 中文警告\u001b[0m\u0000\n"];
      const hash = createHash("sha256");
      const rows: ArchivedLogChunk[] = contents.map((content, sequence) => ({
        attemptId: id,
        frameIndex: 0,
        stream,
        sequence,
        content,
        recordedAt: now,
      }));
      for (const row of rows) {
        hashArchiveChunk(hash, row);
        rawBytes += Buffer.byteLength(row.content);
        chunkCount++;
      }
      const index: LogArchiveStreamIndex = {
        indexOffset,
        frameCount: rows.length ? 1 : 0,
        chunkCount: rows.length,
        rawBytes: rows.reduce((sum, row) => sum + Buffer.byteLength(row.content), 0),
        acknowledgedSequence: rows.length - 1,
        sourceHash: hash.digest("hex"),
      };
      if (rows.length) {
        const frame = encodeArchiveFrame(rows);
        logs.push(frame);
        const descriptor = Buffer.alloc(32);
        descriptor.writeBigUInt64LE(BigInt(logOffset), 0);
        descriptor.writeBigUInt64LE(0n, 8);
        descriptor.writeBigUInt64LE(BigInt(rows.length - 1), 16);
        descriptor.writeUInt32LE(frame.length, 24);
        descriptor.writeUInt32LE(frame.readUInt32LE(12), 28);
        descriptors.push(descriptor);
        indexOffset += 32;
        logOffset += frame.length;
      }
      streams[stream] = index;
    }
    attempts.push({
      id,
      executionRunId: `run-${number}`,
      caseId: `Wallet_中文_${number}`,
      caseType: number % 2 === 0 ? "ddt" : "testng",
      className: `com.example.wallet.${"LongPackage".repeat(4)}.Wallet${number}Test`,
      displayName: number === 0 ? "Wallet_中文_颜色与大日志验证" : "Wallet_中文_" + number,
      roundIndex: (number % 3) + 1,
      attemptNumber: (number % 3) + 1,
      status: number % 2 === 0 ? "failed" : "succeeded",
      outcome: number % 2 === 0 ? "failed" : "succeeded",
      startedAt: now,
      finishedAt: now,
      streams,
    });
  }
  const catalog = encodeArchiveFrame(attempts);
  const files: Record<string, Buffer> = {
    "logs.aflog": Buffer.concat(logs),
    "frames.bin": Buffer.concat(descriptors),
    "catalog.aflog": catalog,
    "catalog.index.json": Buffer.from(
      JSON.stringify([
        {
          firstId: attempts[0]!.id,
          lastId: attempts.at(-1)!.id,
          offset: 0,
          length: catalog.length,
          count: attempts.length,
        },
      ]),
    ),
  };
  for (const [name, content] of Object.entries(files))
    await writeFile(join(location, name), content);
  const manifest: LogArchiveManifest = {
    schemaVersion: 1,
    format: "autoforge-log-archive",
    id: "archive-fixture",
    createdAt: now,
    platformVersion: "fixture",
    month: "2026-10",
    timeZone: "Asia/Shanghai",
    batchCount: 1,
    attemptCount: attempts.length,
    chunkCount,
    rawBytes,
    batches: [
      {
        id: batchId,
        projectId: "project-wallet",
        createdAt: now,
        projectName: "支付平台",
        projectVersionName: "V2026 回归版",
        testStageName: "回归测试",
        suiteName: "Wallet · 中文离线归档 · " + "完整任务名称验证".repeat(12),
        sequenceNumber: 42,
        status: "succeeded",
        finishedAt: now,
      },
    ],
    files: Object.entries(files).map(([name, content]) => ({
      path: `batches/${batchId}/${name}`,
      sizeBytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    })),
  };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
}
