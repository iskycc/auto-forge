import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  issueArchiveDownloadTicket,
  verifyArchiveDownloadTicket,
} from "./log-archive-download-ticket";

const secret = "archive-test-key-".repeat(3);
const now = new Date("2026-10-30T00:00:00Z");
const claims = {
  archiveId: "019a25a1-0000-7000-8000-000000000001",
  actorId: "019a25a1-0000-7000-8000-000000000002",
  sessionHash: "b".repeat(64),
  sha256: "a".repeat(64),
};
describe("scoped archive download tickets", () => {
  it("binds a file checksum and session without including the session cookie", () => {
    const ticket = issueArchiveDownloadTicket(secret, claims, now);
    expect(verifyArchiveDownloadTicket(secret, ticket, now)).toMatchObject(claims);
    expect(
      verifyArchiveDownloadTicket(secret, ticket, new Date(now.getTime() + 86400000)),
    ).toBeNull();
  });
  it("rejects tampering, wrong signing keys and oversized input", () => {
    const ticket = issueArchiveDownloadTicket(secret, claims, now);
    expect(verifyArchiveDownloadTicket(secret, ticket + "x", now)).toBeNull();
    expect(verifyArchiveDownloadTicket(secret + "other", ticket, now)).toBeNull();
    expect(verifyArchiveDownloadTicket(secret, "x".repeat(5000), now)).toBeNull();
  });
});
