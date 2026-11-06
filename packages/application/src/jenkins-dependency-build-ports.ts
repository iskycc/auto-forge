import type { JenkinsDependencyBuild, JenkinsDependencyConnection } from "@autoforge/contracts";

export type JenkinsDependencyRecord = {
  projectId: string;
  versionId: string;
  revision: number;
  connectionCiphertext: string;
  buildRevision: number;
  build?: JenkinsDependencyBuild;
};

export interface JenkinsDependencyRepository {
  versionStatus(projectId: string, versionId: string): Promise<"active" | "archived" | null>;
  read(versionId: string): Promise<JenkinsDependencyRecord | null>;
  save(input: {
    projectId: string;
    versionId: string;
    expectedRevision: number;
    connectionCiphertext: string;
    updatedAt: string;
  }): Promise<boolean>;
  claim(input: {
    versionId: string;
    expectedRevision: number;
    expectedBuildRevision: number;
    build: JenkinsDependencyBuild;
  }): Promise<boolean>;
  updateBuild(
    versionId: string,
    expectedBuildRevision: number,
    build: JenkinsDependencyBuild,
  ): Promise<boolean>;
}

export interface JenkinsDependencyTransport {
  inspect(connection: JenkinsDependencyConnection): Promise<{ name: string; buildable: boolean }>;
  trigger(connection: JenkinsDependencyConnection): Promise<{ queueUrl: string }>;
  poll(
    connection: JenkinsDependencyConnection,
    build: JenkinsDependencyBuild,
  ): Promise<
    Partial<
      Pick<
        JenkinsDependencyBuild,
        | "status"
        | "queueUrl"
        | "buildNumber"
        | "buildUrl"
        | "result"
        | "message"
        | "startedAt"
        | "finishedAt"
      >
    >
  >;
}
