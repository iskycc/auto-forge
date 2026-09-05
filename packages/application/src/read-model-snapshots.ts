import { createHash } from "node:crypto";
import {
  readModelQuerySchema,
  type ReadModelQuery,
  type ReadModelStatus,
} from "@autoforge/contracts";
import type { Clock, IdGenerator } from "./ports";

export type ReadModelSnapshot = {
  id: string;
  query: ReadModelQuery;
  payload: unknown | null;
  generation: string | null;
  generatedAt: string | null;
  refreshAfter: string;
  requestedRevision: number;
  generatedRevision: number;
  failed: boolean;
};

export type ReadModelLease = ReadModelSnapshot & { token: string };

export interface ReadModelSnapshotRepository {
  request(id: string, query: ReadModelQuery, now: string): Promise<ReadModelSnapshot>;
  get(id: string): Promise<ReadModelSnapshot | null>;
  claim(now: string, expiresAt: string, token: string): Promise<ReadModelLease | null>;
  renew(lease: ReadModelLease, now: string, expiresAt: string): Promise<boolean>;
  complete(
    lease: ReadModelLease,
    payload: unknown,
    generatedAt: string,
    refreshAfter: string,
  ): Promise<boolean>;
  fail(lease: ReadModelLease, retryAt: string): Promise<void>;
  invalidate(projectId: string, now: string): Promise<void>;
  putPart(lease: ReadModelLease, ordinal: number, payload: unknown): Promise<void>;
  getPart(id: string, generation: string, ordinal: number): Promise<unknown | null>;
  cleanup(before: string, limit: number): Promise<void>;
}

export class ReadModelSnapshotService {
  constructor(
    private readonly repository: ReadModelSnapshotRepository,
    private readonly clock: Clock,
  ) {}

  async read(input: ReadModelQuery) {
    const query = readModelQuerySchema.parse(input);
    const id = readModelKey(query);
    const snapshot = await this.repository.request(id, query, this.clock.now().toISOString());
    const status = snapshotStatus(snapshot, this.clock.now());
    return {
      ...status,
      status,
      payload: snapshot.payload,
      synchronized: snapshot.generatedRevision === snapshot.requestedRevision,
    };
  }

  invalidate(projectId: string): Promise<void> {
    return this.repository.invalidate(projectId, this.clock.now().toISOString());
  }

  async inspect(id: string) {
    const snapshot = await this.repository.get(id);
    return snapshot
      ? { query: snapshot.query, status: snapshotStatus(snapshot, this.clock.now()) }
      : null;
  }

  async part(id: string, generation: string, ordinal: number) {
    return this.repository.getPart(id, generation, ordinal);
  }
}

export type ReadModelBuilder = (
  query: ReadModelQuery,
  writePart: (ordinal: number, payload: unknown) => Promise<void>,
) => Promise<unknown>;

export class ReadModelSnapshotWorker {
  constructor(
    private readonly repository: ReadModelSnapshotRepository,
    private readonly build: ReadModelBuilder,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly reportError: (error: unknown, query: ReadModelQuery) => void,
  ) {}

  async refreshOne(): Promise<boolean> {
    const now = this.clock.now();
    const lease = await this.repository.claim(
      now.toISOString(),
      after(now, 120_000),
      this.ids.next(),
    );
    if (!lease) return false;
    // Long directory projections renew between bounded chunks. Expired owners cannot publish.
    const writePart = async (ordinal: number, payload: unknown) => {
      if (
        !(await this.repository.renew(
          lease,
          this.clock.now().toISOString(),
          after(this.clock.now(), 120_000),
        ))
      )
        throw new ReadModelRefreshSuperseded("Read model refresh lease was superseded.");
      await this.repository.putPart(lease, ordinal, payload);
    };
    try {
      const payload = await this.build(lease.query, writePart);
      const finishedAt = this.clock.now();
      await this.repository.complete(
        lease,
        payload,
        finishedAt.toISOString(),
        after(
          finishedAt,
          lease.query.kind === "execution_overview" || lease.query.kind === "execution_case_page"
            ? lease.query.terminalVersion === undefined
              ? 5_000
              : 86_400_000
            : lease.query.kind === "batch_counters"
              ? lease.query.batches.every((batch) => batch.terminalVersion !== undefined)
                ? 86_400_000
                : 5_000
              : lease.query.kind === "public_statistics"
                ? lease.query.refreshSeconds * 1_000
                : 60_000,
        ),
      );
    } catch (error) {
      if (!(error instanceof ReadModelRefreshSuperseded)) this.reportError(error, lease.query);
      await this.repository.fail(lease, after(this.clock.now(), 30_000));
    }
    return true;
  }

  cleanup(): Promise<void> {
    return this.repository.cleanup(after(this.clock.now(), -86_400_000), 25);
  }
}

export function readModelKey(query: ReadModelQuery): string {
  return createHash("sha256")
    .update(`read-model:v1:${JSON.stringify(canonical(query))}`)
    .digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}

export function snapshotStatus(snapshot: ReadModelSnapshot, now: Date): ReadModelStatus {
  return {
    id: snapshot.id,
    generation: snapshot.generation,
    generatedAt: snapshot.generatedAt,
    state: snapshot.failed
      ? "failed"
      : snapshot.generatedAt === null
        ? "pending"
        : snapshot.requestedRevision !== snapshot.generatedRevision ||
            snapshot.refreshAfter <= now.toISOString()
          ? "stale"
          : "ready",
  };
}

function after(now: Date, durationMs: number): string {
  return new Date(now.getTime() + durationMs).toISOString();
}

/** An invalidation during a build is expected competition, not a refresh failure. */
class ReadModelRefreshSuperseded extends Error {}
