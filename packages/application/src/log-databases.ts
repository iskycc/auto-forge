import type {
  LogDatabase,
  LogDatabasePage,
  RegisterLogDatabaseInput,
  RegisterDailyLogServerInput,
  PostgresStorageCapacity,
} from "@autoforge/contracts";
import {
  registerLogDatabaseSchema,
  registerDailyLogServerSchema,
  selectLogDatabaseSchema,
} from "@autoforge/contracts";
import type { Clock, IdGenerator } from "./ports";
import { DomainError } from "@autoforge/domain";

export interface LogDatabaseRepository {
  list(cursor?: string): Promise<LogDatabasePage>;
  register(id: string, input: RegisterLogDatabaseInput, now: string): Promise<LogDatabase>;
  registerDaily(id: string, input: RegisterDailyLogServerInput, now: string): Promise<LogDatabase>;
  checkForWrite(id: string): Promise<void>;
  updateDailyConnection(id: string, input: RegisterDailyLogServerInput): Promise<LogDatabase>;
  select(databaseId: string | null, revision: number): Promise<void>;
  check(id: string): Promise<void>;
  updateConnection(id: string, input: RegisterLogDatabaseInput): Promise<LogDatabase>;
  storageCapacity?(id: string, now: Date): Promise<PostgresStorageCapacity>;
}

export class LogDatabaseService {
  private readonly capacities = new Map<
    string,
    { value: PostgresStorageCapacity; expiresAt: number }
  >();
  private readonly capacityRequests = new Map<string, Promise<PostgresStorageCapacity>>();
  private capacityEpoch = 0;
  constructor(
    private readonly repository: LogDatabaseRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  list(cursor?: string) {
    return this.repository.list(cursor);
  }
  register(input: RegisterDailyLogServerInput) {
    return this.repository.registerDaily(
      this.ids.next(),
      registerDailyLogServerSchema.parse(input),
      this.clock.now().toISOString(),
    );
  }
  async select(input: { databaseId: string | null; revision: number }) {
    const selected = selectLogDatabaseSchema.parse(input);
    if (!selected.databaseId)
      throw new DomainError(
        "FULL_LOCAL_LOG_WRITE_DISABLED",
        "Full 模式必须选择 PostgreSQL 日志服务器，不能切换为本地 SQLite 写入。",
      );
    if (selected.databaseId) await this.repository.checkForWrite(selected.databaseId);
    await this.repository.select(selected.databaseId, selected.revision);
  }
  check(id: string) {
    return this.repository.check(id);
  }
  storageCapacity(id: string, refresh = false): Promise<PostgresStorageCapacity> {
    if (!this.repository.storageCapacity)
      throw new DomainError("LOG_DATABASE_UNSUPPORTED", "当前日志存储未提供宿主机容量采样。");
    const now = this.clock.now();
    const cached = this.capacities.get(id);
    if (!refresh && cached && cached.expiresAt > now.getTime())
      return Promise.resolve(cached.value);
    const epoch = this.capacityEpoch;
    const key = `${id}:${epoch}`;
    const pending = this.capacityRequests.get(key);
    if (pending) return pending;
    if (this.capacityRequests.size >= 4)
      throw new DomainError("PLATFORM_LOG_BUSY", "日志服务器容量检查繁忙，请稍后重试。");
    const request = this.repository
      .storageCapacity(id, now)
      .then((value) => {
        if (epoch === this.capacityEpoch) {
          if (this.capacities.size >= 50)
            this.capacities.delete(this.capacities.keys().next().value!);
          this.capacities.set(id, { value, expiresAt: this.clock.now().getTime() + 15_000 });
        }
        return value;
      })
      .finally(() => this.capacityRequests.delete(key));
    this.capacityRequests.set(key, request);
    return request;
  }
  async updateConnection(
    id: string,
    input: RegisterLogDatabaseInput | RegisterDailyLogServerInput,
  ) {
    const result = await ("databaseUrl" in input
      ? this.repository.updateConnection(id, registerLogDatabaseSchema.parse(input))
      : this.repository.updateDailyConnection(id, registerDailyLogServerSchema.parse(input)));
    this.capacityEpoch++;
    this.capacities.clear();
    return result;
  }
}
