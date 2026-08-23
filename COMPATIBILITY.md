# Compatibility matrix

| Control plane | Runner Agent       | Protocol | Java/TestNG baseline     | Result                                                                        |
| ------------- | ------------------ | -------- | ------------------------ | ----------------------------------------------------------------------------- |
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

The `v0.9.10` Jenkins HPI plugins require Jenkins `2.479.3` or newer. The execution plugin requires an
API key with `run.create`; the dependency publisher requires `project.manage` for the target project.

Control plane `0.9.10` adds persisted Webhook configuration and delivery tables without changing
Runner Protocol v1. Existing installations have no endpoint or binding after migration and therefore
retain the prior no-outbound-request behavior until a project administrator explicitly configures one.
