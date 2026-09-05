// Acceptance only: change process wall time without changing the host or monotonic clock.
const offsetMs = Number(process.env.AUTOFORGE_TEST_WALL_CLOCK_OFFSET_MS ?? 0);
if (!Number.isSafeInteger(offsetMs) || Math.abs(offsetMs) > 3_600_000) {
  throw new Error("Invalid acceptance wall clock offset.");
}
const NativeDate = globalThis.Date;
function FixtureDate(...arguments_) {
  if (!new.target) return new NativeDate(NativeDate.now() + offsetMs).toString();
  return Reflect.construct(
    NativeDate,
    arguments_.length ? arguments_ : [NativeDate.now() + offsetMs],
    new.target,
  );
}
Object.setPrototypeOf(FixtureDate, NativeDate);
FixtureDate.prototype = NativeDate.prototype;
FixtureDate.now = () => NativeDate.now() + offsetMs;
// Next.js instruments Date by copying its own static properties.
FixtureDate.parse = NativeDate.parse;
FixtureDate.UTC = NativeDate.UTC;
globalThis.Date = FixtureDate;
