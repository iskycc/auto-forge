import "server-only";

import type {
  DirectoryConfiguration,
  DirectoryIdentity,
  DirectoryPort,
} from "@autoforge/application";
import { DomainError } from "@autoforge/domain";

type LdapClient = InstanceType<(typeof import("ldapts"))["Client"]>;
type SearchEntry = Record<string, unknown> & { dn?: string };

export class LdapDirectory implements DirectoryPort {
  async test(configuration: DirectoryConfiguration): Promise<void> {
    await withServiceClient(configuration, async () => undefined);
  }

  async authenticate(
    configuration: DirectoryConfiguration,
    username: string,
    password: string,
  ): Promise<DirectoryIdentity> {
    if (!password) throw new DomainError("LDAP_CREDENTIAL_REJECTED", "LDAP 凭据无效。");
    return withServiceClient(configuration, async (serviceClient, url) => {
      const identity = await findUser(serviceClient, configuration, username);
      await verifyUserPassword(configuration, url, identity.distinguishedName, password);
      const groupDns = await findGroups(serviceClient, configuration, identity.distinguishedName);
      return { ...identity, groupDns };
    });
  }

  async listUsers(configuration: DirectoryConfiguration): Promise<DirectoryIdentity[]> {
    return withServiceClient(configuration, async (client) => {
      const filter = configuration.userFilter.replaceAll("{username}", "*");
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
          groupDns: await findGroups(client, configuration, identity.distinguishedName),
        });
      }
      return identities;
    });
  }
}

async function withServiceClient<T>(
  configuration: DirectoryConfiguration,
  work: (client: LdapClient, url: string) => Promise<T>,
): Promise<T> {
  const failures: Error[] = [];
  for (const url of configuration.urls) {
    let client: LdapClient | undefined;
    try {
      client = await connect(configuration, url);
      await client.bind(configuration.bindDn, configuration.bindPassword);
      return await work(client, url);
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error("Unknown LDAP error"));
    } finally {
      await client?.unbind().catch(() => undefined);
    }
  }
  throw new DomainError(
    "LDAP_DIRECTORY_UNAVAILABLE",
    "无法连接或绑定 LDAP 目录，请检查地址、TLS、CA 和 bind 凭据。",
    { cause: new AggregateError(failures, "All configured LDAP servers failed") },
  );
}

async function connect(configuration: DirectoryConfiguration, url: string): Promise<LdapClient> {
  const { Client } = await import("ldapts");
  const tlsOptions = {
    minVersion: "TLSv1.2" as const,
    rejectUnauthorized: true,
    ...(configuration.caPem ? { ca: [Buffer.from(configuration.caPem, "utf8")] } : {}),
  };
  const client = new Client({
    url,
    connectTimeout: configuration.connectTimeoutMs,
    timeout: configuration.operationTimeoutMs,
    strictDN: true,
    ...(configuration.tlsMode === "ldaps" ? { tlsOptions } : {}),
  });
  if (configuration.tlsMode === "starttls") await client.startTLS(tlsOptions);
  return client;
}

async function verifyUserPassword(
  configuration: DirectoryConfiguration,
  url: string,
  distinguishedName: string,
  password: string,
): Promise<void> {
  let client: LdapClient | undefined;
  try {
    client = await connect(configuration, url);
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
  const filter = configuration.userFilter.replaceAll("{username}", escapeFilterValue(username));
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
  userDn: string,
): Promise<string[]> {
  if (!configuration.groupBaseDn || !configuration.groupFilter) return [];
  const filter = configuration.groupFilter.replaceAll("{userDn}", escapeFilterValue(userDn));
  const result = await client.search(configuration.groupBaseDn, {
    scope: "sub",
    filter,
    attributes: [],
    sizeLimit: Math.min(configuration.maximumUsers, 10_000),
    paged: { pageSize: configuration.pageSize },
  });
  return (result.searchEntries as SearchEntry[]).flatMap((entry) =>
    typeof entry.dn === "string" ? [entry.dn] : [],
  );
}

function mapDirectoryIdentity(
  entry: SearchEntry,
  configuration: DirectoryConfiguration,
): DirectoryIdentity {
  const distinguishedName = stringAttribute(entry, "dn");
  const subject = stringAttribute(entry, configuration.userIdAttribute);
  const username = stringAttribute(entry, configuration.usernameAttribute);
  if (!distinguishedName || !subject || !username) {
    throw new DomainError("LDAP_MAPPING_INVALID", "LDAP 用户缺少 DN、稳定标识或用户名映射属性。");
  }
  const displayName = stringAttribute(entry, configuration.displayNameAttribute) || username;
  const email = stringAttribute(entry, configuration.emailAttribute);
  return {
    subject,
    username,
    displayName,
    ...(email ? { email } : {}),
    distinguishedName,
    groupDns: [],
    attributes: Object.fromEntries(
      userAttributes(configuration).flatMap((attribute) => {
        const value = stringAttribute(entry, attribute);
        return value ? [[attribute, value]] : [];
      }),
    ),
  };
}

function userAttributes(configuration: DirectoryConfiguration): string[] {
  return [
    configuration.userIdAttribute,
    configuration.usernameAttribute,
    configuration.displayNameAttribute,
    configuration.emailAttribute,
  ];
}

function stringAttribute(entry: SearchEntry, attribute: string): string {
  const value = entry[attribute];
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (Array.isArray(value)) {
    const first = value[0];
    if (typeof first === "string") return first;
    if (Buffer.isBuffer(first)) return first.toString("utf8");
  }
  return "";
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
