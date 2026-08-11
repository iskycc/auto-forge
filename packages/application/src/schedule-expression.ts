import { DomainError } from "@autoforge/domain";

type ScheduleParts = {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
};

const MAXIMUM_SEARCH_MINUTES = 366 * 24 * 60;

export function validateCronExpression(expression: string, timeZone: string): void {
  parseCronExpression(expression);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch (error) {
    throw new DomainError("SCHEDULE_TIME_ZONE_INVALID", "计划时区不是有效的 IANA 时区。", {
      cause: error,
    });
  }
}

export function nextCronOccurrence(expression: string, timeZone: string, after: Date): Date {
  const schedule = parseCronExpression(expression);
  validateCronExpression(expression, timeZone);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
    weekday: "short",
  });
  let candidate = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  for (let index = 0; index < MAXIMUM_SEARCH_MINUTES; index += 1) {
    const fields = dateFields(formatter, candidate);
    if (
      schedule.minute.has(fields.minute) &&
      schedule.hour.has(fields.hour) &&
      schedule.dayOfMonth.has(fields.dayOfMonth) &&
      schedule.month.has(fields.month) &&
      schedule.dayOfWeek.has(fields.dayOfWeek)
    ) {
      return candidate;
    }
    candidate = new Date(candidate.getTime() + 60_000);
  }
  throw new DomainError("SCHEDULE_NEXT_TRIGGER_UNAVAILABLE", "一年内找不到下一次计划触发时间。");
}

function parseCronExpression(expression: string): ScheduleParts {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new DomainError("SCHEDULE_CRON_INVALID", "Cron 表达式必须包含五个字段。");
  }
  return {
    minute: parseField(fields[0] ?? "", 0, 59),
    hour: parseField(fields[1] ?? "", 0, 23),
    dayOfMonth: parseField(fields[2] ?? "", 1, 31),
    month: parseField(fields[3] ?? "", 1, 12),
    dayOfWeek: parseField(fields[4] ?? "", 0, 6, true),
  };
}

function parseField(
  value: string,
  minimum: number,
  maximum: number,
  sundayAlias = false,
): Set<number> {
  const selected = new Set<number>();
  for (const segment of value.split(",")) {
    const [rangePart, stepPart] = segment.split("/");
    const step = stepPart === undefined ? 1 : parseInteger(stepPart);
    if (step < 1 || step > maximum - minimum + 1) invalidCron();
    let start = minimum;
    let end = maximum;
    if (rangePart !== "*") {
      const bounds = rangePart?.split("-") ?? [];
      start = parseValue(bounds[0], minimum, maximum, sundayAlias);
      end = bounds.length === 1 ? start : parseValue(bounds[1], minimum, maximum, sundayAlias);
      if (start > end) invalidCron();
    }
    for (let current = start; current <= end; current += step) selected.add(current);
  }
  if (selected.size === 0) invalidCron();
  return selected;
}

function parseValue(
  value: string | undefined,
  minimum: number,
  maximum: number,
  sundayAlias: boolean,
): number {
  const parsed = parseInteger(value);
  if (sundayAlias && parsed === 7) return 0;
  if (parsed < minimum || parsed > maximum) invalidCron();
  return parsed;
}

function parseInteger(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) invalidCron();
  return Number(value);
}

function invalidCron(): never {
  throw new DomainError("SCHEDULE_CRON_INVALID", "Cron 表达式包含无效字段。");
}

function dateFields(formatter: Intl.DateTimeFormat, date: Date) {
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? "");
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    dayOfMonth: Number(parts.day),
    month: Number(parts.month),
    dayOfWeek: weekday,
  };
}
