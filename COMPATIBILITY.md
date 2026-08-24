# Compatibility matrix

| Control plane | Runner Agent       | Protocol | Java/TestNG baseline     | Result                                                                        |
| ------------- | ------------------ | -------- | ------------------------ | ----------------------------------------------------------------------------- |
| `1.1.x`       | embedded `1.1.x`   | v1       | Java 11+ / TestNG 7.11.0 | supported                                                                     |
| `1.1.x`       | embedded `1.0.x`   | v1       | Java 11+ / TestNG 7.11.0 | supported; control-plane DDT features do not change the Runner contract       |
| `1.0.x`       | embedded `1.0.x`   | v1       | Java 11+ / TestNG 7.11.0 | supported                                                                     |
| `1.0.x`       | embedded `0.9.x`   | v1       | capability dependent     | supported; upgrade recommended                                                |
| `0.9.x`       | embedded `0.9.x`   | v1       | Java 11+ / TestNG 7.11.0 | supported                                                                     |
| `0.9.x`       | `0.8.x`            | v1       | capability dependent     | upgrade recommended; incompatible capabilities are rejected before assignment |
| `0.9.x`       | future protocol v2 | v2       | unknown                  | rejected with `RUNNER_PROTOCOL_UNSUPPORTED`                                   |

The installer always selects the Agent embedded in the running control-plane image. Credential rotation
allows a 15-minute recovery overlap; it is not a protocol compatibility window. Database downgrade is
not supported after new migrations are committed. Rollback therefore means restoring the pre-upgrade
database/object backup and starting the previous immutable image together.

Persisted platform configuration schema v1 is shared by Web and worker. A worker must use the exact
same `/var/lib/autoforge` volume and release version as Web during normal operation and rolling upgrades.
Mixed Web/worker versions are allowed only for the bounded drain interval documented in the upgrade
runbook.

Protocol v1 keeps the historical `environment` and `secretReferences` JSON fields for wire parsing only.
Control plane `0.9.x` emits empty values, and the embedded Agent rejects non-empty values because product-level
managed execution environments and secrets have been retired.

The `v1.0.x` and `v1.1.x` Jenkins HPI plugins require Jenkins `2.479.3` or newer. CI loads each installed Pipeline
step through Jenkins Pipeline Job `1508.v9cb_c3a_a_89dfd` and Pipeline Groovy
`4009.v0089238351a_9`, then verifies the packaged HPI manifest and step bytecode. The execution plugin requires an
API key with `run.create`; the dependency publisher requires `project.manage` for the target project.

Control plane `1.0.0` adds `run_batches.scheduled_for`. Upgrades backfill it from `created_at`; API
callers that omit `delaySeconds` retain immediate execution. Database downgrade still requires a
pre-upgrade database/object backup.

Control plane `1.0.1` adds task-level dynamic retry concurrency and leased Jenkins round recovery
state without changing Runner Protocol v1. Existing policies default to empty rule arrays. Jenkins
round recovery requires the Rebuilder plugin and a single `username:API Token` credential; that
credential is encrypted with the existing AutoForge master key and cannot be configured without it.

Control plane `1.0.2` keeps the `1.0.1` database and protocol contracts and fixes policy-rule editing
when the UI is served from a plain-HTTP hostname or IP address. Persisted `1.0.1` task policies and
credentials remain directly compatible.

Control plane `1.1.0` adds version-scoped DDT tables and raw spreadsheet objects without changing
Runner Protocol v1 or existing TestNG assets. The Web and Full worker must be upgraded together so
`ddt-import` jobs have a registered consumer. Database downgrade requires restoring the database and
object store backup taken before migrations `0042` (SQLite) or `0041` (PostgreSQL).

Control plane `1.1.1` keeps the `1.1.0` database schema and Runner Protocol v1. Online Agents resume
assignment claims after disabled/draining state is cleared. Jenkins HPI `1.1.1` forces HTTP/1.1,
honors server polling guidance and adds a bounded wait timeout; existing Pipeline calls remain valid.

Control plane `0.9.10` adds persisted Webhook configuration and delivery tables without changing
Runner Protocol v1. Existing installations have no endpoint or binding after migration and therefore
retain the prior no-outbound-request behavior until a project administrator explicitly configures one.

Control plane `0.9.11` does not change persisted schemas or Runner Protocol v1. Existing suites and
batches with a valid `projectVersionId` policy snapshot remain executable; ambiguous legacy suites
must be assigned an active project version before any browser, schedule, Jenkins or API execution.
