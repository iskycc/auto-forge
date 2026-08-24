import { describe, expect, it, vi } from "vitest";

import { rejectH2cUpgrade } from "../../server/http-upgrade";

describe("plaintext HTTP/2 upgrades", () => {
  it("returns an explicit HTTP response instead of dropping h2c connections", () => {
    const end = vi.fn();

    expect(rejectH2cUpgrade({ headers: { upgrade: "h2c" } }, { end })).toBe(true);
    expect(end).toHaveBeenCalledOnce();
    expect(end.mock.calls[0]?.[0]).toContain("HTTP/1.1 400 Bad Request");
    expect(end.mock.calls[0]?.[0]).toContain("H2C_UPGRADE_UNSUPPORTED");
  });

  it("leaves WebSocket upgrades to their registered gateways", () => {
    const end = vi.fn();

    expect(rejectH2cUpgrade({ headers: { upgrade: "websocket" } }, { end })).toBe(false);
    expect(end).not.toHaveBeenCalled();
  });
});
