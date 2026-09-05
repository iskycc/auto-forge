import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("clock fault injection preserves Date statics copied by framework instrumentation", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      new URL("./clock-skew-fixture.mjs", import.meta.url).pathname,
      "--input-type=module",
      "-e",
      `import assert from "node:assert/strict";
     assert.ok(Object.hasOwn(Date, "UTC"));
     assert.ok(Object.hasOwn(Date, "parse"));
     assert.equal(new Date("2026-01-01Z").getTime(), Date.UTC(2026, 0, 1));
     assert.ok(Math.abs(Date.now() - (performance.timeOrigin + performance.now()) - 600000) < 1000);
     assert.equal(typeof Date(), "string");`,
    ],
    { env: { ...process.env, AUTOFORGE_TEST_WALL_CLOCK_OFFSET_MS: "600000" }, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});
