import "server-only";

import type {
  DirectoryConfiguration,
  DirectoryIdentity,
  DirectoryPort,
} from "@autoforge/application";
import { DomainError, isDomainError } from "@autoforge/domain";

import { combinedLdapFailure, ldapDiagnostic, type LdapOperationPhase } from "./ldap-diagnostics";

type LdapClient = Pick<
  InstanceType<(typeof import("ldapts"))["Client"]>,
  "bind" | "search" | "startTLS" | "unbind"
>;
type SearchEntry = Record<string, unknown> & { dn?: string };
export type LdapConnector = (
  configuration: DirectoryConfiguration,
  url: string,
) => Promise<LdapClient>;

export class LdapDirectory implements DirectoryPort {
  constructor(private readonly connector: LdapConnector = connect) {}

  async test(configuration: DirectoryConfiguration): Promise<void> {
    await withServiceClient(configuration, this.connector, async (client) => {
      await validateSearchAccess(client, configuration);
    });
  }

  async authenticate(
    configuration: DirectoryConfiguration,
    username: string,
    password: string,
  ): Promise<DirectoryIdentity> {
    if (!password) throw new DomainError("LDAP_CREDENTIAL_REJECTED", "LDAP 凭据无效。");
    return withServiceClient(configuration, this.connector, async (serviceClient, url) => {
      const identity = await findUser(serviceClient, configuration, username);
      await verifyUserPassword(
        configuration,
        this.connector,
        url,
        identity.distinguishedName,
        password,
      );
      const groupDns = await findGroups(serviceClient, configuration, username, identity);
      return { ...identity, groupDns };
    });
  }

  async listUsers(configuration: DirectoryConfiguration): Promise<DirectoryIdentity[]> {
    return withServiceClient(configuration, this.connector, async (client) => {
      const filter = replaceDirectoryPlaceholder(configuration.userFilter, "username", "*");
      const result = await client.search(configuration.userBaseDn, {
        scope: "sub",
        filter,
        attributes: userAttributes(configuration),
        sizeLimit: configuration.maximumUsers,
        paged: { pageSize: configuration.pageSize },
      });
      const identities: DirectoryIdentity[] = [];
      for (const entry of result.searchEntries as SearchEntry[]) {
        const identity = mapDirectoryIdentity(entry, configuration);
        identities.push({
          ...identity,
          groupDns: await findGroups(client, configuration, identity.username, identity),
        });
      }
      return identities;
    });
  }
}

async function withServiceClient<T>(
  configuration: DirectoryConfiguration,
  connector: LdapConnector,
  work: (client: LdapClient, url: string) => Promise<T>,
): Promise<T> {
  const failures: DomainError[] = [];
  for (const url of [configuration.url]) {
    let client: LdapClient | undefined;
    try {
      client = await runLdapPhase("connect", () => connector(configuration, url), url);
      if (configuration.bindDn) {
        await runLdapPhase(
          "bind",
          () => client!.bind(configuration.bindDn, configuration.bindPassword),
          url,
        );
      }
      return await runLdapPhase("search", () => work(client!, url), url);
    } catch (failure) {
      failures.push(
        isDomainError(failure)
          ? failure
          : new DomainError("LDAP_DIRECTORY_UNAVAILABLE", "LDAP 目录操作失败。", {
              cause: failure,
            }),
      );
    } finally {
      await client?.unbind().catch(() => undefined);
    }
  }
  throw combinedLdapFailure(failures);
}

async function runLdapPhase<T>(
  phase: LdapOperationPhase,
  operation: () => Promise<T>,
  url: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw ldapDiagnostic(error, phase, url);
  }
}

async function connect(configuration: DirectoryConfiguration, url: string): Promise<LdapClient> {
  const { Client } = await import("ldapts");
  const plan = ldapConnectionPlan(configuration, url);
  const client = new Client(plan.clientOptions);
  if (plan.startTlsOptions) await client.startTLS(plan.startTlsOptions);
  return client;
}

export function ldapConnectionPlan(configuration: DirectoryConfiguration, url: string) {
  const tlsOptions = {
    minVersion: "TLSv1.2" as const,
    rejectUnauthorized: configuration.verifyTlsCertificate,
    ...(configuration.caPem ? { ca: [Buffer.from(configuration.caPem, "utf8")] } : {}),
  };
  const implicitTls = configuration.transportMode !== "starttls" && usesImplicitTls(url);
  return {
    clientOptions: {
      url,
      connectTimeout: configuration.connectTimeoutMs,
      timeout: configuration.operationTimeoutMs,
      strictDN: true,
      ...(implicitTls ? { tlsOptions } : {}),
    },
    ...(configuration.transportMode === "starttls" ? { startTlsOptions: tlsOptions } : {}),
  };
}

function usesImplicitTls(url: string): boolean {
  const parsed = new URL(url);
  return (
    parsed.protocol === "ldaps:" ||
    (parsed.protocol === "ldap:" && (parsed.port === "636" || parsed.port === "3269"))
  );
}

async function verifyUserPassword(
  configuration: DirectoryConfiguration,
  connector: LdapConnector,
  url: string,
  distinguishedName: string,
  password: string,
): Promise<void> {
  let client: LdapClient | undefined;
  try {
    client = await connector(configuration, url);
    await client.bind(distinguishedName, password);
  } catch (error) {
    throw new DomainError("LDAP_CREDENTIAL_REJECTED", "LDAP 凭据无效。", { cause: error });
  } finally {
    await client?.unbind().catch(() => undefined);
  }
}

async function findUser(
  client: LdapClient,
  configuration: DirectoryConfiguration,
  username: string,
): Promise<DirectoryIdentity> {
  const filter = replaceDirectoryPlaceholder(
    configuration.userFilter,
    "username",
    escapeFilterValue(username),
  );
  const result = await client.search(configuration.userBaseDn, {
    scope: "sub",
    filter,
    attributes: userAttributes(configuration),
    sizeLimit: 2,
  });
  if (result.searchEntries.length !== 1) {
    throw new DomainError("LDAP_CREDENTIAL_REJECTED", "LDAP 凭据无效。");
  }
  return mapDirectoryIdentity(result.searchEntries[0] as SearchEntry, configuration);
}

async function findGroups(
  client: LdapClient,
  configuration: DirectoryConfiguration,
  username: string,
  identity: DirectoryIdentity,
): Promise<string[]> {
  if (!configuration.groupSearchBase) return identity.groupDns;
  const filter = replaceDirectoryPlaceholder(
    replaceDirectoryPlaceholder(
      configuration.groupSearchFilter,
      "username",
      escapeFilterValue(username),
    ),
    "userDn",
    escapeFilterValue(identity.distinguishedName),
  );
  const result = await client.search(configuration.groupSearchBase, {
    scope: "sub",
    filter,
    attributes: [configuration.groupNameAttribute],
    sizeLimit: Math.min(configuration.maximumUsers, 512),
    paged: { pageSize: configuration.pageSize },
  });
  return uniqueAttributes(
    (result.searchEntries as SearchEntry[]).flatMap((entry) =>
      attributeTexts(entry, configuration.groupNameAttribute),
    ),
  );
}

async function validateSearchAccess(
  client: LdapClient,
  configuration: DirectoryConfiguration,
): Promise<void> {
  await client.search(configuration.userBaseDn, {
    scope: "base",
    filter: "(objectClass=*)",
    attributes: ["1.1"],
    sizeLimit: 1,
    timeLimit: Math.max(1, Math.ceil(configuration.operationTimeoutMs / 1_000)),
  });
  if (!configuration.groupSearchBase) return;
  await client.search(configuration.groupSearchBase, {
    scope: "base",
    filter: "(objectClass=*)",
    attributes: ["1.1"],
    sizeLimit: 1,
    timeLimit: Math.max(1, Math.ceil(configuration.operationTimeoutMs / 1_000)),
  });
}

function mapDirectoryIdentity(
  entry: SearchEntry,
  configuration: DirectoryConfiguration,
): DirectoryIdentity {
  const distinguishedName = stringAttribute(entry, "dn");
  const username = stringAttribute(entry, configuration.usernameAttribute);
  if (!distinguishedName || !username) {
    throw new DomainError("LDAP_MAPPING_INVALID", "LDAP 用户缺少 DN 或用户名映射属性。");
  }
  const displayName = stringAttribute(entry, configuration.displayNameAttribute) || username;
  const email = stringAttribute(entry, configuration.emailAttribute);
  return {
    subject: normalizeDirectoryUsername(username),
    username,
    displayName,
    ...(email ? { email } : {}),
    distinguishedName,
    groupDns: uniqueAttributes(attributeTexts(entry, configuration.groupAttribute)),
    attributes: Object.fromEntries(
      userAttributes(configuration).flatMap((attribute) => {
        const value = stringAttribute(entry, attribute);
        return value ? [[attribute, value]] : [];
      }),
    ),
  };
}

function userAttributes(configuration: DirectoryConfiguration): string[] {
  return uniqueAttributes([
    configuration.usernameAttribute,
    configuration.displayNameAttribute,
    configuration.emailAttribute,
    configuration.groupSearchBase ? "" : configuration.groupAttribute,
  ]);
}

function stringAttribute(entry: SearchEntry, attribute: string): string {
  return attributeTexts(entry, attribute)[0] ?? "";
}

function attributeTexts(entry: SearchEntry, attribute: string): string[] {
  if (!attribute) return [];
  const expected = attribute.toLocaleLowerCase("en-US");
  return Object.entries(entry)
    .filter(([name]) => {
      const normalized = name.toLocaleLowerCase("en-US");
      return normalized === expected || normalized.startsWith(`${expected};`);
    })
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .map((value) => (Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "")))
    .map((value) => value.trim())
    .filter(Boolean);
}

function uniqueAttributes(values: string[]): string[] {
  const unique = new Map<string, string>();
  for (const rawValue of values) {
    const value = rawValue.trim();
    if (!value) continue;
    const normalized = value.toLocaleLowerCase("en-US");
    if (!unique.has(normalized)) unique.set(normalized, value);
    if (unique.size >= 512) break;
  }
  return [...unique.values()];
}

function normalizeDirectoryUsername(username: string): string {
  return username.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function replaceDirectoryPlaceholder(
  template: string,
  placeholder: "username" | "userDn",
  value: string,
): string {
  const current = `{{${placeholder}}}`;
  return template.includes(current)
    ? template.replaceAll(current, value)
    : template.replaceAll(`{${placeholder}}`, value);
}

function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\u0000]/g, (character) => {
    if (character === "\\") return "\\5c";
    if (character === "*") return "\\2a";
    if (character === "(") return "\\28";
    if (character === ")") return "\\29";
    return "\\00";
  });
}
