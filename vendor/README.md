# Vendored offline dependencies

`xlsx-0.20.3.tgz` is the exact SheetJS Community Edition npm package used by
`@autoforge/ddt-import`. It is vendored so locked production installs and release builds do not need
public network access. The archive contains its upstream Apache-2.0 `LICENSE`; the package and
version are also emitted by `pnpm licenses:generate` into the repository-wide third-party inventory.

Do not replace this archive without reviewing its license, integrity, Node 24 compatibility and
spreadsheet/ZIP regression suite, then updating `pnpm-lock.yaml` and the license inventory.

`patches/exceljs@4.4.0.patch` fixes the streaming writer's Open XML worksheet feature order:
protection precedes filters, and data validation precedes hyperlinks. Without this patch, an analysis
export with dropdowns and log links can pass XML parsing and LibreOffice reads while Excel rejects
the worksheet. The patch is pinned by `pnpm-workspace.yaml` and its hash in `pnpm-lock.yaml`; it is
applied during dependency installation, including offline Docker builds. ExcelJS remains version
4.4.0 under its existing MIT license, with no additional package or runtime download.

Keep the patch available before `pnpm fetch` (the Docker dependencies stage already copies
`vendor/`). On an ExcelJS upgrade, verify the generated worksheet sequence, dropdowns, hyperlink
targets, styles, pagination, exclusions and cancellation before removing or refreshing the patch.
