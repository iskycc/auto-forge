# Compatibility matrix

| Control plane | Runner Agent | Protocol | Java/TestNG baseline | Result |
| --- | --- | --- | --- | --- |
| `0.2.x` | embedded `0.2.x` | v1 | Java 11+ / TestNG 7.11.0 | supported |
| `0.2.x` | `0.1.x` | v1 | capability dependent | upgrade recommended; incompatible capabilities are rejected before assignment |
| `0.2.x` | future protocol v2 | v2 | unknown | rejected with `RUNNER_PROTOCOL_UNSUPPORTED` |

The installer always selects the Agent embedded in the running control-plane image. Credential rotation
allows a 15-minute recovery overlap; it is not a protocol compatibility window. Database downgrade is
not supported after new migrations are committed. Rollback therefore means restoring the pre-upgrade
database/object backup and starting the previous immutable image together.

Persisted platform configuration schema v1 is shared by Web and worker. A worker must use the exact
same `/var/lib/autoforge` volume and release version as Web during normal operation and rolling upgrades.
Mixed Web/worker versions are allowed only for the bounded drain interval documented in the upgrade
runbook.
