import { opendir, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";

import type { JarObjectStorePort, ProjectStructureService } from "@autoforge/application";
import type {
  StorageInventoryCategory,
  StorageInventoryItem,
  StorageInventoryPage,
  StorageInventorySummary,
} from "@autoforge/contracts";
import type { ProjectRuntimeAsset } from "@autoforge/domain";

const SOURCE_ORDER = ["local", "object", "external"] as const;
const INVENTORY_BATCH_SIZE = 200;
// 完整汇总需要遍历数据目录和 MinIO；目录树通过游标分批读取并在前端自动合并，
// 五分钟内复用汇总，管理员仍可通过“重新扫描”显式失效缓存。
const SUMMARY_CACHE_MS = 5 * 60_000;

type InventorySource = (typeof SOURCE_ORDER)[number];
type InventoryCursor = { source: InventorySource; key: string };
type InventoryEntry = { cursor: InventoryCursor; item: StorageInventoryItem };

export type StorageInventoryQuery = {
  cursor?: string;
  limit: number;
  category?: StorageInventoryCategory;
  query?: string;
  refresh?: boolean;
};

export class StorageInventoryService {
  private summaryCache: { expiresAt: number; value: StorageInventorySummary } | undefined;
  private summaryInFlight: Promise<StorageInventorySummary> | undefined;

  constructor(
    private readonly options: {
      dataDirectory: string;
      objectStore: JarObjectStorePort;
      projectStructures: Pick<
        ProjectStructureService,
        "listRuntimeAssetsPage" | "findRuntimeAssetsByObjectKeys"
      >;
      objectStoreRoot: string;
      now?: () => Date;
    },
  ) {}

  async list(input: StorageInventoryQuery): Promise<StorageInventoryPage> {
    assertQuery(input);
    if (input.refresh) this.summaryCache = undefined;
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
    const items: InventoryEntry[] = [];
    for await (const entry of this.entries(cursor)) {
      if (!matches(entry.item, input.category, input.query)) continue;
      items.push(entry);
      if (items.length > input.limit) break;
    }
    const pageEntries = items.slice(0, input.limit);
    const last = pageEntries.at(-1);
    return {
      items: pageEntries.map((entry) => entry.item),
      ...(items.length > input.limit && last ? { nextCursor: encodeCursor(last.cursor) } : {}),
      summary: await this.summary(),
    };
  }

  private async summary(): Promise<StorageInventorySummary> {
    const now = Date.now();
    if (this.summaryCache && this.summaryCache.expiresAt > now) return this.summaryCache.value;
    if (this.summaryInFlight) return this.summaryInFlight;
    this.summaryInFlight = this.buildSummary();
    try {
      const value = await this.summaryInFlight;
      this.summaryCache = { expiresAt: now + SUMMARY_CACHE_MS, value };
      return value;
    } finally {
      this.summaryInFlight = undefined;
    }
  }

  private async buildSummary(): Promise<StorageInventorySummary> {
    const categories = new Map<
      StorageInventoryCategory,
      { fileCount: number; logicalBytes: number; allocatedBytes: number }
    >();
    let fileCount = 0;
    let logicalBytes = 0;
    let allocatedBytes = 0;
    let externalReferenceCount = 0;
    let externalReferenceBytes = 0;
    for await (const { item } of this.entries()) {
      fileCount += 1;
      logicalBytes = addBytes(logicalBytes, item.sizeBytes);
      allocatedBytes = addBytes(allocatedBytes, item.allocatedBytes);
      if (item.location === "external-reference") {
        externalReferenceCount += 1;
        externalReferenceBytes = addBytes(externalReferenceBytes, item.sizeBytes);
      }
      const category = categories.get(item.category) ?? {
        fileCount: 0,
        logicalBytes: 0,
        allocatedBytes: 0,
      };
      category.fileCount += 1;
      category.logicalBytes = addBytes(category.logicalBytes, item.sizeBytes);
      category.allocatedBytes = addBytes(category.allocatedBytes, item.allocatedBytes);
      categories.set(item.category, category);
    }
    return {
      generatedAt: (this.options.now?.() ?? new Date()).toISOString(),
      dataDirectory: resolve(this.options.dataDirectory),
      objectStore: this.options.objectStore.storageKind,
      objectStoreRoot: this.options.objectStoreRoot,
      fileCount,
      logicalBytes,
      allocatedBytes,
      externalReferenceCount,
      externalReferenceBytes,
      categories: [...categories.entries()]
        .map(([category, values]) => ({ category, ...values }))
        .sort(
          (left, right) =>
            right.allocatedBytes - left.allocatedBytes ||
            left.category.localeCompare(right.category),
        ),
    };
  }

  private async *entries(after?: InventoryCursor): AsyncGenerator<InventoryEntry> {
    if (sourceCanFollow(after, "local")) {
      yield* this.localEntries(after?.source === "local" ? after.key : undefined);
    }
    if (this.options.objectStore.storageKind === "minio" && sourceCanFollow(after, "object")) {
      yield* this.objectEntries(after?.source === "object" ? after.key : undefined);
    }
    if (sourceCanFollow(after, "external")) {
      yield* this.externalEntries(after?.source === "external" ? after.key : undefined);
    }
  }

  private async *localEntries(afterPath?: string): AsyncGenerator<InventoryEntry> {
    let pending: LocalFile[] = [];
    const root = resolve(this.options.dataDirectory);
    for await (const file of walkFiles(root, root, afterPath?.split("/"))) {
      pending.push(file);
      if (pending.length < INVENTORY_BATCH_SIZE) continue;
      yield* this.mapLocalBatch(pending);
      pending = [];
    }
    if (pending.length > 0) yield* this.mapLocalBatch(pending);
  }

  private async *mapLocalBatch(files: readonly LocalFile[]): AsyncGenerator<InventoryEntry> {
    const objectKeys = files.flatMap((file) => {
      const key = localObjectKey(file.logicalPath);
      return key ? [key] : [];
    });
    const assets = await this.options.projectStructures.findRuntimeAssetsByObjectKeys(objectKeys);
    const assetByObjectKey = new Map(
      assets.flatMap((asset) => (asset.objectKey ? [[asset.objectKey, asset] as const] : [])),
    );
    for (const file of files) {
      const objectKey = localObjectKey(file.logicalPath);
      const asset = objectKey ? assetByObjectKey.get(objectKey) : undefined;
      yield {
        cursor: { source: "local", key: file.logicalPath },
        item: localInventoryItem(file, objectKey, asset),
      };
    }
  }

  private async *objectEntries(afterKey?: string): AsyncGenerator<InventoryEntry> {
    let cursor = afterKey;
    for (;;) {
      const page = await this.options.objectStore.list({
        limit: INVENTORY_BATCH_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      const assets = await this.options.projectStructures.findRuntimeAssetsByObjectKeys(
        page.items.map((item) => item.objectKey),
      );
      const assetByObjectKey = new Map(
        assets.flatMap((asset) => (asset.objectKey ? [[asset.objectKey, asset] as const] : [])),
      );
      for (const object of page.items) {
        yield {
          cursor: { source: "object", key: object.objectKey },
          item: objectInventoryItem(
            object,
            this.options.objectStoreRoot,
            assetByObjectKey.get(object.objectKey),
          ),
        };
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
  }

  private async *externalEntries(afterId?: string): AsyncGenerator<InventoryEntry> {
    let cursor = afterId;
    for (;;) {
      const page = await this.options.projectStructures.listRuntimeAssetsPage({
        sourceType: "url",
        limit: INVENTORY_BATCH_SIZE,
        ...(cursor ? { afterId: cursor } : {}),
      });
      for (const asset of page.items) {
        yield {
          cursor: { source: "external", key: asset.id },
          item: externalInventoryItem(asset),
        };
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
  }
}

type LocalFile = {
  absolutePath: string;
  logicalPath: string;
  sizeBytes: number;
  allocatedBytes: number;
  modifiedAt: string;
};

async function* walkFiles(
  root: string,
  directory = root,
  afterSegments?: readonly string[],
): AsyncGenerator<LocalFile> {
  let handle;
  try {
    handle = await opendir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const entries = [];
  for await (const entry of handle) entries.push(entry);
  entries.sort((left, right) => comparePaths(left.name, right.name));
  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);
    const logicalPath = relative(root, absolutePath).split(sep).join("/");
    const cursorSegment = afterSegments?.[0];
    const cursorComparison = cursorSegment ? comparePaths(entry.name, cursorSegment) : 1;
    if (afterSegments && cursorComparison < 0) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (afterSegments && cursorComparison === 0) {
        if (afterSegments.length > 1) {
          yield* walkFiles(root, absolutePath, afterSegments.slice(1));
        }
        continue;
      }
      yield* walkFiles(root, absolutePath);
      continue;
    }
    if (!entry.isFile()) continue;
    if (afterSegments && cursorComparison === 0) continue;
    const metadata = await stat(absolutePath);
    yield {
      absolutePath,
      logicalPath,
      sizeBytes: metadata.size,
      allocatedBytes: Number.isFinite(metadata.blocks) ? metadata.blocks * 512 : metadata.size,
      modifiedAt: metadata.mtime.toISOString(),
    };
  }
}

function localInventoryItem(
  file: LocalFile,
  objectKey: string | undefined,
  asset: ProjectRuntimeAsset | undefined,
): StorageInventoryItem {
  const classification = classify(file.logicalPath, objectKey, asset);
  return {
    id: `local:${file.logicalPath}`,
    category: classification.category,
    location: "data-directory",
    name: asset?.fileName ?? basename(file.logicalPath),
    logicalPath: file.logicalPath,
    storagePath: file.absolutePath,
    sizeBytes: file.sizeBytes,
    allocatedBytes: file.allocatedBytes,
    modifiedAt: file.modifiedAt,
    ...(projectIdFromObjectKey(objectKey) ? { projectId: projectIdFromObjectKey(objectKey) } : {}),
    ...(classification.detail ? { detail: classification.detail } : {}),
  };
}

function objectInventoryItem(
  object: { objectKey: string; sizeBytes: number; lastModified: string },
  root: string,
  asset: ProjectRuntimeAsset | undefined,
): StorageInventoryItem {
  const classification = classify(object.objectKey, object.objectKey, asset);
  return {
    id: `object:${object.objectKey}`,
    category: classification.category,
    location: "object-store",
    name: asset?.fileName ?? basename(object.objectKey),
    logicalPath: object.objectKey,
    storagePath: `${root.replace(/\/$/u, "")}/${object.objectKey}`,
    sizeBytes: object.sizeBytes,
    // MinIO 只能报告对象内容大小，后端副本/纠删码开销由存储集群负责。
    allocatedBytes: object.sizeBytes,
    modifiedAt: object.lastModified,
    ...(projectIdFromObjectKey(object.objectKey)
      ? { projectId: projectIdFromObjectKey(object.objectKey) }
      : {}),
    ...(classification.detail ? { detail: classification.detail } : {}),
  };
}

function externalInventoryItem(asset: ProjectRuntimeAsset): StorageInventoryItem {
  return {
    id: `external:${asset.id}`,
    category: asset.kind === "jdk" ? "jdk" : "dependency",
    location: "external-reference",
    name: asset.fileName,
    logicalPath: `projects/${asset.projectId}/runtime-assets/${asset.id}`,
    storagePath: safeExternalPath(asset.url),
    sizeBytes: asset.sizeBytes,
    allocatedBytes: 0,
    modifiedAt: asset.createdAt,
    projectId: asset.projectId,
    detail: asset.kind === "jdk" ? "外部 JDK 包（平台未保存文件）" : "外部依赖包（平台未保存文件）",
  };
}

function classify(
  path: string,
  objectKey: string | undefined,
  asset: ProjectRuntimeAsset | undefined,
): { category: StorageInventoryCategory; detail?: string } {
  if (asset?.kind === "jdk") return { category: "jdk", detail: "JDK 运行时压缩包" };
  if (asset?.kind === "jar-bundle") return { category: "dependency", detail: "测试依赖压缩包" };
  if (/\.sqlite(?:-(?:wal|shm|journal))?$/u.test(path)) {
    return path.startsWith("attempt-logs/")
      ? { category: "execution-log", detail: sqliteDetail(path, "批次日志 SQLite") }
      : { category: "database", detail: sqliteDetail(path, "平台 SQLite") };
  }
  if (objectKey?.includes("/artifacts/")) return { category: "artifact", detail: "执行产物" };
  if (objectKey?.includes("/ddt-imports/"))
    return { category: "ddt-import", detail: "DDT 导入源文件" };
  if (objectKey?.includes("/analytics-exports/")) {
    return { category: "analytics-export", detail: "质量分析导出" };
  }
  if (objectKey?.includes("/jars/")) return { category: "case-source", detail: "用例来源 JAR" };
  if (path.startsWith("config/")) return { category: "configuration", detail: "平台配置文件" };
  if (/(?:^|\/)(?:tmp|temp|staging)(?:\/|$)|\.tmp$/iu.test(path)) {
    return { category: "temporary", detail: "临时或上传暂存文件" };
  }
  return { category: "other" };
}

function sqliteDetail(path: string, prefix: string): string {
  if (path.endsWith("-wal")) return `${prefix} WAL`;
  if (path.endsWith("-shm")) return `${prefix} 共享内存索引`;
  if (path.endsWith("-journal")) return `${prefix} 回滚日志`;
  return `${prefix} 主文件`;
}

function localObjectKey(path: string): string | undefined {
  return path.startsWith("objects/") ? path.slice("objects/".length) : undefined;
}

function projectIdFromObjectKey(objectKey: string | undefined): string | undefined {
  return objectKey?.match(/^projects\/([^/]+)\//u)?.[1];
}

function safeExternalPath(value: string | undefined): string {
  if (!value) return "外部地址未记录";
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${url.search ? "?[查询参数已隐藏]" : ""}`;
  } catch {
    return "外部地址格式无效（地址已隐藏）";
  }
}

function matches(
  item: StorageInventoryItem,
  category: StorageInventoryCategory | undefined,
  query: string | undefined,
): boolean {
  if (category && item.category !== category) return false;
  const normalized = query?.trim().toLocaleLowerCase("zh-CN");
  if (!normalized) return true;
  return [item.name, item.logicalPath, item.storagePath, item.projectId ?? "", item.detail ?? ""]
    .join("\n")
    .toLocaleLowerCase("zh-CN")
    .includes(normalized);
}

function sourceCanFollow(after: InventoryCursor | undefined, source: InventorySource): boolean {
  if (!after) return true;
  return SOURCE_ORDER.indexOf(source) >= SOURCE_ORDER.indexOf(after.source);
}

function encodeCursor(cursor: InventoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): InventoryCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("invalid");
    const source = Reflect.get(parsed, "source");
    const key = Reflect.get(parsed, "key");
    if (!SOURCE_ORDER.includes(source as InventorySource) || typeof key !== "string" || !key) {
      throw new Error("invalid");
    }
    return { source: source as InventorySource, key };
  } catch {
    throw new Error("存储清单游标无效。");
  }
}

function assertQuery(input: StorageInventoryQuery): void {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
    throw new Error("存储清单单次读取数量必须在 1 到 500 之间。");
  }
}

function comparePaths(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function addBytes(current: number, increment: number): number {
  const result = current + increment;
  if (!Number.isSafeInteger(result)) throw new Error("存储清单大小超过安全整数范围。");
  return result;
}
