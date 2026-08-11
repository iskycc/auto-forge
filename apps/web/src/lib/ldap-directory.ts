import "server-only";

import type {
  DirectoryConfiguration,
  DirectoryIdentity,
  DirectoryPort,
} from "@autoforge/application";
import { DomainError } from "@autoforge/domain";

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
      const groupDns = await findGroups(serviceClient, configuration, identity.distinguishedName);
      return { ...identity, groupDns };
    });
  }

  async listUsers(configuration: DirectoryConfiguration): Promise<DirectoryIdentity[]> {
    return withServiceClient(configuration, this.connector, async (client) => {
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
  connector: LdapConnector,
  work: (client: LdapClient, url: string) => Promise<T>,
): Promise<T> {
  const failures: DomainError[] = [];
  for (const url of configuration.urls) {
    let client: LdapClient | undefined;
    try {
      client = await runLdapPhase("connect", () => connector(configuration, url));
      await runLdapPhase("bind", () =>
        client!.bind(configuration.bindDn, configuration.bindPassword),
      );
      return await runLdapPhase("search", () => work(client!, url));
    } catch (failure) {
      failures.push(
        failure instanceof DomainError
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

async function runLdapPhase<T>(phase: LdapOperationPhase, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw ldapDiagnostic(error, phase);
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
    rejectUnauthorized: true,
    ...(configuration.caPem ? { ca: [Buffer.from(configuration.caPem, "utf8")] } : {}),
  };
  return {
    clientOptions: {
      url,
      connectTimeout: configuration.connectTimeoutMs,
      timeout: configuration.operationTimeoutMs,
      strictDN: true,
      ...(configuration.tlsMode === "ldaps" ? { tlsOptions } : {}),
    },
    ...(configuration.tlsMode === "starttls" ? { startTlsOptions: tlsOptions } : {}),
  };
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

async function validateSearchAccess(
  client: LdapClient,
  configuration: DirectoryConfiguration,
): Promise<void> {
  await client.search(configuration.userBaseDn, {
    scope: "sub",
    filter: configuration.userFilter.replaceAll("{username}", "*"),
    attributes: [configuration.userIdAttribute],
    sizeLimit: 1,
    timeLimit: Math.max(1, Math.ceil(configuration.operationTimeoutMs / 1_000)),
  });
  if (!configuration.groupBaseDn || !configuration.groupFilter) return;
  await client.search(configuration.groupBaseDn, {
    scope: "sub",
    filter: configuration.groupFilter.replaceAll(
      "{userDn}",
      escapeFilterValue(configuration.bindDn),
    ),
    attributes: [],
    sizeLimit: 1,
    timeLimit: Math.max(1, Math.ceil(configuration.operationTimeoutMs / 1_000)),
  });
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
