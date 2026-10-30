import type {
  LogDatabase,
  LogDatabasePage,
  RegisterLogDatabaseInput,
  RegisterDailyLogServerInput,
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
}

export class LogDatabaseService {
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
  updateConnection(id: string, input: RegisterLogDatabaseInput | RegisterDailyLogServerInput) {
    return "databaseUrl" in input
      ? this.repository.updateConnection(id, registerLogDatabaseSchema.parse(input))
      : this.repository.updateDailyConnection(id, registerDailyLogServerSchema.parse(input));
  }
}
