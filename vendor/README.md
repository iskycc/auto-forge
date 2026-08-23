# Vendored offline dependencies

`xlsx-0.20.3.tgz` is the exact SheetJS Community Edition npm package used by
`@autoforge/ddt-import`. It is vendored so locked production installs and release builds do not need
public network access. The archive contains its upstream Apache-2.0 `LICENSE`; the package and
version are also emitted by `pnpm licenses:generate` into the repository-wide third-party inventory.

Do not replace this archive without reviewing its license, integrity, Node 24 compatibility and
spreadsheet/ZIP regression suite, then updating `pnpm-lock.yaml` and the license inventory.
