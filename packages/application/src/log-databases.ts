import type { LogDatabase, LogDatabasePage, RegisterLogDatabaseInput } from "@autoforge/contracts";
import { registerLogDatabaseSchema, selectLogDatabaseSchema } from "@autoforge/contracts";
import type { Clock, IdGenerator } from "./ports";

export interface LogDatabaseRepository {
  list(cursor?: string): Promise<LogDatabasePage>;
  register(id: string, input: RegisterLogDatabaseInput, now: string): Promise<LogDatabase>;
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
  register(input: RegisterLogDatabaseInput) {
    return this.repository.register(
      this.ids.next(),
      registerLogDatabaseSchema.parse(input),
      this.clock.now().toISOString(),
    );
  }
  async select(input: { databaseId: string | null; revision: number }) {
    const selected = selectLogDatabaseSchema.parse(input);
    if (selected.databaseId) await this.repository.check(selected.databaseId);
    await this.repository.select(selected.databaseId, selected.revision);
  }
  check(id: string) {
    return this.repository.check(id);
  }
  updateConnection(id: string, input: RegisterLogDatabaseInput) {
    return this.repository.updateConnection(id, registerLogDatabaseSchema.parse(input));
  }
}
