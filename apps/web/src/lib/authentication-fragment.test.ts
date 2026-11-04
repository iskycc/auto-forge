import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import {
  authenticationFragmentCaptureScript,
  AUTHENTICATION_FRAGMENT_KEY,
  restoreAuthenticationFragment,
} from "./authentication-fragment";

it("captures the original business fragment before a streamed redirect without overwriting it at auth entries", () => {
  const storage = new Map<string, string>();
  const window = {
    location: { href: "http://platform.local/execution-records?kind=single#history" },
    sessionStorage: { setItem: (key: string, value: string) => storage.set(key, value) },
  };
  runInNewContext(authenticationFragmentCaptureScript(), { window, URL });
  const remembered = storage.get(AUTHENTICATION_FRAGMENT_KEY)!;
  expect(JSON.parse(remembered)).toMatchObject({
    path: "/execution-records?kind=single",
    hash: "#history",
  });
  for (const entry of ["/login", "/register", "/?login=1"]) {
    window.location.href = `http://platform.local${entry}#other`;
    runInNewContext(authenticationFragmentCaptureScript(), { window, URL });
    expect(storage.get(AUTHENTICATION_FRAGMENT_KEY)).toBe(remembered);
  }
});

it("restores only a matching recent fragment and preserves explicit anchors", () => {
  const remembered = JSON.stringify({
    path: "/execution-records?kind=single",
    hash: "#history",
    recordedAt: 1000,
  });
  expect(restoreAuthenticationFragment("/execution-records?kind=single", remembered, 2000)).toBe(
    "/execution-records?kind=single#history",
  );
  expect(restoreAuthenticationFragment("/CaseLog?ExecutionId=other", remembered, 2000)).toBe(
    "/CaseLog?ExecutionId=other",
  );
  expect(
    restoreAuthenticationFragment("/execution-records?kind=single#explicit", remembered, 2000),
  ).toBe("/execution-records?kind=single#explicit");
  expect(restoreAuthenticationFragment("/execution-records?kind=single", remembered, 301001)).toBe(
    "/execution-records?kind=single",
  );
  expect(
    restoreAuthenticationFragment("/execution-records?kind=single", "invalid-json", 2000),
  ).toBe("/execution-records?kind=single");
});

it("allows navigation when browser policy blocks session storage", () => {
  const window = {
    location: { href: "http://platform.local/CaseLog?ExecutionId=case#log" },
    sessionStorage: {
      setItem: () => {
        throw new Error("blocked");
      },
    },
  };
  expect(() =>
    runInNewContext(authenticationFragmentCaptureScript(), { window, URL }),
  ).not.toThrow();
});
