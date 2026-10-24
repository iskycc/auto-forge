import type {
  JobEnvelope,
  ProjectVersionCopy,
  CreateProjectVersionCopy,
  ProjectVersionCopyTargets,
} from "@autoforge/contracts";

export type VersionCopyRow = Record<string, string | number | boolean | null>;
export type VersionCopySnapshotDescriptor = {
  objectKey: string;
  sha256: string;
  sizeBytes: number;
};
export type VersionCopyState = Omit<ProjectVersionCopy, "targetVersionId"> & {
  targetVersionId: string;
  requestKey: string;
  snapshot: VersionCopySnapshotDescriptor | null;
  cursor: number;
  collectionIndex: number;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
};
export type VersionCopyCollection = { name: string; primaryKey: readonly string[] };
export type VersionCopyRecord = {
  collection: string;
  ordinal: number;
  key: string;
  row: VersionCopyRow;
};
export type VersionCopyObjectReference = { objectKey: string; sha256?: string; sizeBytes?: number };
export type VersionCopyObject = VersionCopyObjectReference & { ordinal: number };
export type VersionCopyManifest = {
  schemaVersion: 1;
  collections: Array<VersionCopyCollection & { count: number }>;
  objects: number;
  attempts: number;
  rows: number;
};

export interface VersionCopySnapshotReader {
  manifest: VersionCopyManifest;
  records(collection: string, after: number, limit: number): Promise<VersionCopyRecord[]>;
  objects(after: number, limit: number): Promise<VersionCopyObject[]>;
  find(collection: string, key: string): Promise<VersionCopyRow | null>;
  close(): Promise<void>;
}
export interface VersionCopySnapshotSink {
  append(collection: VersionCopyCollection, rows: readonly VersionCopyRow[]): Promise<void>;
}

export interface ProjectVersionCopyRepository {
  create(
    input: CreateProjectVersionCopy & {
      id: string;
      allocatedTargetVersionId: string;
      actorId: string;
      now: string;
      job: JobEnvelope;
    },
  ): Promise<VersionCopyState>;
  listTargets(projectId: string, afterId?: string): Promise<ProjectVersionCopyTargets>;
  get(id: string): Promise<VersionCopyState | null>;
  list(projectIds: readonly string[] | undefined, projectId: string): Promise<VersionCopyState[]>;
  claim(
    id: string,
    token: string,
    now: string,
    expiresAt: string,
  ): Promise<VersionCopyState | null>;
  save(state: VersionCopyState, expectedToken: string): Promise<void>;
  renew(id: string, token: string, now: string, expiresAt: string): Promise<boolean>;
  fail(
    id: string,
    token: string,
    now: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void>;
  release(id: string, token: string, now: string): Promise<void>;
  action(
    id: string,
    action: "retry" | "cancel",
    now: string,
    job: JobEnvelope,
  ): Promise<VersionCopyState>;
  capture(
    state: VersionCopyState,
    sink: VersionCopySnapshotSink,
    signal: AbortSignal,
  ): Promise<void>;
  insertPage(
    state: VersionCopyState,
    records: readonly VersionCopyRecord[],
    token: string,
  ): Promise<void>;
  finish(state: VersionCopyState, manifest: VersionCopyManifest, token: string): Promise<void>;
  removePage(
    state: VersionCopyState,
    collection: VersionCopyCollection,
    keys: readonly VersionCopyRow[],
    token: string,
  ): Promise<void>;
  removeTarget(state: VersionCopyState, token: string): Promise<void>;
}

export interface VersionCopyArchivePort {
  capture(
    state: VersionCopyState,
    signal: AbortSignal,
  ): Promise<{ descriptor: VersionCopySnapshotDescriptor; manifest: VersionCopyManifest }>;
  open(
    descriptor: VersionCopySnapshotDescriptor,
    signal: AbortSignal,
  ): Promise<VersionCopySnapshotReader>;
  ensureObjectCapacity(sizeBytes: number): Promise<void>;
}

export interface VersionCopyLogPort {
  acknowledgedSequence(
    batchId: string,
    attemptId: string,
    stream: "stdout" | "stderr" | "agent",
  ): number | Promise<number>;
  listChunks(input: {
    batchId: string;
    attemptId: string;
    stream: "stdout" | "stderr" | "agent";
    afterSequence: number;
    limit: number;
  }): Promise<{
    items: Array<{
      stream: "stdout" | "stderr" | "agent";
      sequence: number;
      content: string;
      recordedAt: string;
    }>;
    hasMore: boolean;
  }>;
  appendChunks(input: {
    batchId: string;
    attemptId: string;
    receivedAt: string;
    chunks: Array<{
      stream: "stdout" | "stderr" | "agent";
      sequence: number;
      content: string;
      recordedAt: string;
    }>;
  }): Promise<unknown>;
  removeBatchStore(batchId: string): void | Promise<void>;
}
