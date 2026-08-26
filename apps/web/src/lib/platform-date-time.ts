import { DEFAULT_PLATFORM_TIME_ZONE } from "@autoforge/contracts";

export { DEFAULT_PLATFORM_TIME_ZONE };

type DateTimeValue = Date | string | number;
let configuredPlatformTimeZone = DEFAULT_PLATFORM_TIME_ZONE;

const DATE_TIME_INPUT_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2}))?$/u;

export function activePlatformTimeZone(): string {
  if (typeof document === "undefined") return configuredPlatformTimeZone;
  return document.documentElement.dataset.timeZone || configuredPlatformTimeZone;
}

export function configurePlatformTimeZone(timeZone: string): void {
  configuredPlatformTimeZone = timeZone || DEFAULT_PLATFORM_TIME_ZONE;
}

export function formatPlatformDateTime(
  value: DateTimeValue,
  timeZone = activePlatformTimeZone(),
  options: Intl.DateTimeFormatOptions = { dateStyle: "short", timeStyle: "medium" },
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", { ...options, timeZone }).format(date);
}

export function formatPlatformTime(
  value: DateTimeValue,
  timeZone = activePlatformTimeZone(),
): string {
  return formatPlatformDateTime(value, timeZone, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function platformDateTimeInputValue(
  value: DateTimeValue | undefined,
  timeZone = activePlatformTimeZone(),
): string {
  if (value === undefined || value === "") return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = dateTimeParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function platformDateTimeInputToIso(
  value: string,
  timeZone = activePlatformTimeZone(),
): string | undefined {
  const match = DATE_TIME_INPUT_PATTERN.exec(value.trim());
  if (!match?.groups) return undefined;
  const expected = {
    year: match.groups.year!,
    month: match.groups.month!,
    day: match.groups.day!,
    hour: match.groups.hour!,
    minute: match.groups.minute!,
    second: match.groups.second ?? "00",
  };
  const utcWallClock = Date.UTC(
    Number(expected.year),
    Number(expected.month) - 1,
    Number(expected.day),
    Number(expected.hour),
    Number(expected.minute),
    Number(expected.second),
  );
  let candidate = utcWallClock - timeZoneOffsetMs(new Date(utcWallClock), timeZone);
  const correctedOffset = timeZoneOffsetMs(new Date(candidate), timeZone);
  candidate = utcWallClock - correctedOffset;
  const date = new Date(candidate);
  const actual = dateTimeParts(date, timeZone);
  if (Object.entries(expected).some(([key, part]) => actual[key as keyof typeof actual] !== part)) {
    return undefined;
  }
  return date.toISOString();
}

export function platformDateTimeParameterToIso(
  value: string,
  timeZone = activePlatformTimeZone(),
): string | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (DATE_TIME_INPUT_PATTERN.test(normalized)) {
    return platformDateTimeInputToIso(normalized, timeZone);
  }
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function dateTimeParts(date: Date, timeZone: string) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    hour: values.hour!,
    minute: values.minute!,
    second: values.second!,
  };
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = dateTimeParts(date, timeZone);
  const representedAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return representedAsUtc - Math.floor(date.getTime() / 1_000) * 1_000;
}
