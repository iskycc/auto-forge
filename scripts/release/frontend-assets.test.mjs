import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyAndRecordFrontendAssets } from "./frontend-assets.mjs";

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "autoforge-frontend-assets-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const packaged = join(root, "packaged");
  const manifest = join(root, "frontend-assets.json");
  await mkdir(join(source, "chunks"), { recursive: true });
  await writeFile(join(source, "chunks/app.js"), "export const ui = 'offline';");
  await writeFile(join(source, "chunks/lazy-dialog.js"), "export const modal = true;");
  await writeFile(
    join(source, "chunks/antd.css"),
    [
      "btn",
      "modal",
      "table",
      "collapse",
      "tabs",
      "menu",
      "popover",
      "progress",
      "pagination",
      "alert",
      "empty",
      "spin",
      "checkbox",
      "select",
      "picker",
      "tag",
      "segmented",
      "result",
      "statistic",
    ]
      .map((component) => `.ant-${component}{box-sizing:border-box}`)
      .join(""),
  );
  await writeFile(join(source, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await cp(source, packaged, { recursive: true });
  return { source, packaged, manifest };
}

test("records every local asset including lazily loaded chunks and checksums", async (context) => {
  const { source, packaged, manifest } = await fixture(context);
  const result = await verifyAndRecordFrontendAssets(source, packaged, manifest);
  assert.equal(result.assets.length, 4);
  assert.ok(result.assets.some((asset) => asset.path.endsWith("lazy-dialog.js")));
  assert.ok(result.assets.every((asset) => /^[a-f\d]{64}$/u.test(asset.sha256)));
  assert.deepEqual(JSON.parse(await readFile(manifest, "utf8")), result);
});

test("rejects a missing lazy chunk before an offline release can be exported", async (context) => {
  const { source, packaged, manifest } = await fixture(context);
  await rm(join(packaged, "chunks/lazy-dialog.js"));
  await assert.rejects(
    verifyAndRecordFrontendAssets(source, packaged, manifest),
    /missing frontend asset.*lazy-dialog/u,
  );
});

test("rejects stale or damaged packaged assets", async (context) => {
  const { source, packaged, manifest } = await fixture(context);
  await writeFile(join(packaged, "chunks/app.js"), "old build");
  await assert.rejects(
    verifyAndRecordFrontendAssets(source, packaged, manifest),
    /differs from the production build/u,
  );
});

test("rejects CDN and remote font dependencies", async (context) => {
  const { source, packaged, manifest } = await fixture(context);
  for (const css of [
    '@import "https://example.invalid/theme.css";',
    "@font-face{src:url(//example.invalid/font.woff2)}",
  ]) {
    for (const directory of [source, packaged])
      await writeFile(join(directory, "chunks/antd.css"), css);
    await assert.rejects(
      verifyAndRecordFrontendAssets(source, packaged, manifest),
      /remote resource/u,
    );
  }
});

test("rejects a frontend build which omits Ant Design styles", async (context) => {
  const { source, packaged, manifest } = await fixture(context);
  for (const directory of [source, packaged])
    await writeFile(join(directory, "chunks/antd.css"), "body{margin:0}");
  await assert.rejects(
    verifyAndRecordFrontendAssets(source, packaged, manifest),
    /Ant Design component CSS is missing/u,
  );
});

test("rejects partial component styles even when button and modal styles exist", async (context) => {
  const { source, packaged, manifest } = await fixture(context);
  for (const directory of [source, packaged]) {
    const path = join(directory, "chunks/antd.css");
    await writeFile(path, (await readFile(path, "utf8")).replace(/\.ant-table\{[^}]*\}/u, ""));
  }
  await assert.rejects(
    verifyAndRecordFrontendAssets(source, packaged, manifest),
    /Ant Design component CSS is missing.*table/u,
  );
});
