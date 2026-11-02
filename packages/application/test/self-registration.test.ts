import { expect, it, vi } from "vitest";
import { IdentityAccessService } from "../src/manage-identity-access";
import type { CompleteLocalRegistrationRecord, IdentityAccessRepository } from "../src/ports";

function fixture() {
  const repository = {
    hasUsers: vi.fn(async () => true),
    getLdapConfiguration: vi
      .fn<IdentityAccessRepository["getLdapConfiguration"]>()
      .mockResolvedValue(null),
    completeLocalRegistration: vi.fn(async (input: CompleteLocalRegistrationRecord) => ({
      id: input.user.id,
    })),
  };
  const hash = vi.fn(async () => "hashed-password");
  let sequence = 0;
  const service = new IdentityAccessService(
    repository as unknown as IdentityAccessRepository,
    { hash, verify: vi.fn() },
    {
      issue: () => "opaque-session",
      hash: (token) => `hash:${token}`,
      verifyBootstrapToken: () => false,
    },
    { available: false, encrypt: vi.fn(), decrypt: vi.fn() },
    { authenticate: vi.fn(), test: vi.fn() },
    { now: () => new Date("2026-11-02T00:00:00.000Z") },
    { next: () => `registration-${++sequence}` },
    24,
  );
  return { repository, hash, service };
}
const registration = {
  username: "New.User",
  displayName: "新用户",
  password: "LocalUser!Password123",
  confirmPassword: "LocalUser!Password123",
};

it("creates an atomic local registration with a usable session and no forced password change", async () => {
  const f = fixture();
  expect(await f.service.register(registration, "registration-request")).toEqual({
    userId: "registration-1",
    token: "opaque-session",
    expiresAt: "2026-11-03T00:00:00.000Z",
  });
  const recorded = f.repository.completeLocalRegistration.mock.calls[0]![0];
  expect(recorded).toMatchObject({
    user: {
      normalizedUsername: "new.user",
      passwordHash: "hashed-password",
      forcePasswordChange: false,
    },
    session: { tokenHash: "hash:opaque-session" },
    defaultRole: {
      projectId: "00000000-0000-7000-8000-000000000001",
      roleId: "00000000-0000-7000-8100-000000000004",
    },
    audit: {
      action: "auth.register",
      actorId: "registration-1",
      requestId: "registration-request",
    },
  });
  expect(JSON.stringify(recorded)).not.toContain(registration.password);
});

it("rejects initialization takeover and privilege injection before hashing or persistence", async () => {
  const f = fixture();
  f.repository.hasUsers.mockResolvedValue(false);
  await expect(f.service.register(registration)).rejects.toMatchObject({
    code: "AUTH_REGISTRATION_UNAVAILABLE",
  });
  await expect(
    f.service.register({ ...registration, forcePasswordChange: false }),
  ).rejects.toThrow();
  expect(f.hash).not.toHaveBeenCalled();
  expect(f.repository.completeLocalRegistration).not.toHaveBeenCalled();
});

it("closes registration when LDAP is enabled without hashing a new password", async () => {
  const f = fixture();
  f.repository.getLdapConfiguration.mockResolvedValue({ enabled: true } as Awaited<
    ReturnType<IdentityAccessRepository["getLdapConfiguration"]>
  >);
  expect(await f.service.registrationAvailability()).toEqual({
    enabled: false,
    reason: "ldap_enabled",
  });
  await expect(f.service.register(registration)).rejects.toMatchObject({
    code: "AUTH_REGISTRATION_UNAVAILABLE",
  });
  expect(f.hash).not.toHaveBeenCalled();
});
