import type { JenkinsDependencyRepository, JenkinsDependencyRecord } from "@autoforge/application";
import { jenkinsDependencyBuildSchema } from "@autoforge/contracts";

type Row = {
  project_id: string;
  version_id: string;
  revision: number;
  connection_ciphertext: string;
  build_revision: number;
  build_json: string | null;
};
export type JenkinsDependencyQuery = <R extends Record<string, unknown>>(
  statement: string,
  values: Array<string | number | null>,
) => Promise<R[]>;
const unreservedVersion =
  "NOT EXISTS (SELECT 1 FROM project_version_copies c WHERE c.target_version_id=v.id AND c.status NOT IN ('completed','cancelled'))";
const activeVersion = `EXISTS (SELECT 1 FROM project_versions v JOIN projects p ON p.id=v.project_id
 WHERE v.id=version_jenkins_dependencies.version_id AND v.project_id=version_jenkins_dependencies.project_id AND v.status='active' AND p.archived=FALSE AND ${unreservedVersion})`;
const inactiveBuild =
  "(build_status IS NULL OR build_status IN ('succeeded','failed','cancelled','closed'))";

/** Only short, conditional statements are used; no connection remains checked out during Jenkins I/O. */
export class JenkinsDependencySqlRepository implements JenkinsDependencyRepository {
  constructor(private readonly query: JenkinsDependencyQuery) {}
  async versionStatus(projectId: string, versionId: string) {
    const rows = await this.query<{ status: "active" | "archived" }>(
      `SELECT CASE WHEN p.archived=TRUE THEN 'archived' ELSE v.status END AS status FROM project_versions v JOIN projects p ON p.id=v.project_id WHERE v.project_id=? AND v.id=? AND ${unreservedVersion}`,
      [projectId, versionId],
    );
    return rows[0]?.status ?? null;
  }
  async read(versionId: string): Promise<JenkinsDependencyRecord | null> {
    const rows = await this.query<Row>(
      "SELECT project_id,version_id,revision,connection_ciphertext,build_revision,build_json FROM version_jenkins_dependencies WHERE version_id=?",
      [versionId],
    );
    const row = rows[0];
    return row
      ? {
          projectId: row.project_id,
          versionId: row.version_id,
          revision: row.revision,
          connectionCiphertext: row.connection_ciphertext,
          buildRevision: row.build_revision,
          ...(row.build_json
            ? { build: jenkinsDependencyBuildSchema.parse(JSON.parse(row.build_json)) }
            : {}),
        }
      : null;
  }
  async save(input: Parameters<JenkinsDependencyRepository["save"]>[0]) {
    const values = [input.versionId, input.projectId, input.connectionCiphertext, input.updatedAt];
    const rows =
      input.expectedRevision === 0
        ? await this.query(
            `INSERT INTO version_jenkins_dependencies(version_id,project_id,connection_ciphertext,updated_at)
          SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM project_versions v JOIN projects p ON p.id=v.project_id WHERE v.id=? AND v.project_id=? AND v.status='active' AND p.archived=FALSE AND ${unreservedVersion})
          ON CONFLICT(version_id) DO NOTHING RETURNING version_id`,
            [...values, input.versionId, input.projectId],
          )
        : await this.query(
            `UPDATE version_jenkins_dependencies SET connection_ciphertext=?,updated_at=?,revision=revision+1 WHERE version_id=? AND project_id=? AND revision=? AND ${inactiveBuild} AND ${activeVersion} RETURNING version_id`,
            [
              input.connectionCiphertext,
              input.updatedAt,
              input.versionId,
              input.projectId,
              input.expectedRevision,
            ],
          );
    return rows.length === 1;
  }
  async claim(input: Parameters<JenkinsDependencyRepository["claim"]>[0]) {
    const rows = await this.query(
      `UPDATE version_jenkins_dependencies SET build_status=?,build_json=?,build_revision=build_revision+1 WHERE version_id=? AND revision=? AND build_revision=? AND ${inactiveBuild} AND ${activeVersion} RETURNING version_id`,
      [
        input.build.status,
        JSON.stringify(input.build),
        input.versionId,
        input.expectedRevision,
        input.expectedBuildRevision,
      ],
    );
    return rows.length === 1;
  }
  async updateBuild(
    versionId: string,
    expectedBuildRevision: number,
    build: NonNullable<JenkinsDependencyRecord["build"]>,
  ) {
    const rows = await this.query(
      "UPDATE version_jenkins_dependencies SET build_status=?,build_json=?,build_revision=build_revision+1 WHERE version_id=? AND build_revision=? RETURNING version_id",
      [build.status, JSON.stringify(build), versionId, expectedBuildRevision],
    );
    return rows.length === 1;
  }
}
