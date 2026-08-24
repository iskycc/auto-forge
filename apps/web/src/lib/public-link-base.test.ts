import { describe, expect, it } from "vitest";

import { publicLinkBase } from "./public-link-base";

describe("publicLinkBase", () => {
  it("prefers the explicitly configured external address", () => {
    const request = new Request("http://0.0.0.0:3000/api/v1/example", {
      headers: { host: "container.internal:3000" },
    });

    expect(publicLinkBase("https://autoforge.example/", request)).toBe("https://autoforge.example");
  });

  it("uses the first reverse-proxy host and protocol", () => {
    const request = new Request("http://0.0.0.0:3000/api/v1/example", {
      headers: {
        host: "container.internal:3000",
        "x-forwarded-host": "autoforge.example, proxy.internal",
        "x-forwarded-proto": "https, http",
      },
    });

    expect(publicLinkBase(undefined, request)).toBe("https://autoforge.example");
  });

  it("uses the request Host instead of an internal listener URL", () => {
    const request = new Request("http://0.0.0.0:3000/api/v1/example", {
      headers: { host: "10.20.30.40:3200" },
    });

    expect(publicLinkBase(undefined, request)).toBe("http://10.20.30.40:3200");
  });

  it("falls back to the request origin when no public headers are available", () => {
    const request = new Request("http://127.0.0.1:3100/api/v1/example");

    expect(publicLinkBase(undefined, request)).toBe("http://127.0.0.1:3100");
  });
});
