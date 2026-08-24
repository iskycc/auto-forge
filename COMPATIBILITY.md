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

Control plane `1.1.5` adds SQLite migration `0043` and PostgreSQL migration `0042` so one retry-round
boundary can persist multiple concurrent Jenkins recovery steps. Runner Protocol v1 is unchanged.
The Jenkins run response adds an optional permanent anonymous `resultUrl`; HPI `1.1.5` returns and
prints it after terminal completion while retaining compatibility with older servers. Case and run
permanent links are scoped HMAC capabilities tied to the stable installation master key and become
unresolvable when the referenced record is deleted. v1.1.5 replaces release `.docker.tar.zst`
archives with Docker-native `.docker.tar`; upgrade acceptance can still import an older zstd archive.

Control plane `1.1.6` keeps the v1.1.5 database and Runner Protocol contracts. It corrects absolute
public-link fallback behind direct containers and reverse proxies; an explicitly configured public
base URL still takes precedence. Jenkins HPI `1.1.6` keeps the v1.1.5 Pipeline arguments and result
map, and release images remain Docker-native `.docker.tar` archives.

Control plane `1.1.8` keeps the v1.1.6 database, persisted configuration and Runner Protocol
contracts. Lite continues to run its job worker in the Web process and does not require a separate
worker service; transient SQLite queue failures are now retried with bounded backoff. Jenkins HPI
`1.1.8` keeps the existing Pipeline arguments and result map, and release images remain Docker-native
`.docker.tar` archives.

Control plane `1.1.10` adds SQLite migration `0044_sticky_retry_concurrency.sql` and PostgreSQL
migration `0043_sticky_retry_concurrency.sql` for the batch-level active concurrency stage. Dynamic
concurrency output and current input use one `executionRound`; stored and legacy API range rules remain
accepted and map `executionRoundFrom` to that trigger. Runner Protocol v1 and Jenkins Pipeline arguments/results are
unchanged. Jenkins HPI `1.1.10` remains compatible with the prior server contract, and release images
remain Docker-native `.docker.tar` archives.

Control plane `1.2.0` keeps the v1.1.10 persisted schemas and Runner Protocol v1. Public-base and
artifact-collection settings are hot-applied; other persisted configuration fields still require the
explicit restart reported by the settings UI. Existing Jenkins Pipeline calls remain valid, while HPI
`1.2.0` defaults dependency metadata to ZIP so `fileName` and `archiveFormat` may be omitted. Permanent
run links and Webhook test calls are additive HTTP APIs. Release images remain Docker-native
`.docker.tar` archives.

Control plane `0.9.10` adds persisted Webhook configuration and delivery tables without changing
Runner Protocol v1. Existing installations have no endpoint or binding after migration and therefore
retain the prior no-outbound-request behavior until a project administrator explicitly configures one.

Control plane `0.9.11` does not change persisted schemas or Runner Protocol v1. Existing suites and
batches with a valid `projectVersionId` policy snapshot remain executable; ambiguous legacy suites
must be assigned an active project version before any browser, schedule, Jenkins or API execution.
