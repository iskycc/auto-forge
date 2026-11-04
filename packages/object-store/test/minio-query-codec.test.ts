import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const sdkPackage = require.resolve("minio/package.json");
const sdkRequire = createRequire(sdkPackage);
const queryCodec = sdkRequire("query-string") as {
  stringify(parameters: Record<string, string>): string;
  parse(query: string): Record<string, string>;
};

describe("MinIO query codec compatibility", () => {
  it("preserves Unicode and reserved characters through the SDK's CommonJS dependency", () => {
    const parameters = { CaseID: "Wallet 中文用例", versionId: "v1+a/b=", marker: "%完成" };
    const encoded = queryCodec.stringify(parameters);
    expect(encoded).toContain("Wallet%20%E4%B8%AD%E6%96%87");
    expect(queryCodec.parse(encoded)).toEqual(parameters);
    expect(queryCodec.parse("CaseID=%E4%B8%AD%E6%96%87%zz")).toEqual({ CaseID: "中文%zz" });
  });

  it("decodes many distinct malformed runs within a bounded child process", async () => {
    const script = `
      import { createRequire } from 'node:module';
      const require = createRequire(process.argv[1]);
      const codec = require('query-string');
      let payload = '';
      for (let index=0; index<32000; index++) {
        const high=Math.floor(index/256).toString(16).padStart(2,'0');
        const low=(index%256).toString(16).padStart(2,'0');
        payload += '%' + high + '%' + low + 'x';
      }
      const result=codec.parse('CaseID='+payload+'%zz');
      if (typeof result.CaseID !== 'string' || !result.CaseID.endsWith('%zz'))
        throw new Error('Malformed query did not preserve its undecodable suffix.');
      process.stdout.write('decoded');
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "--eval", script, sdkPackage],
      { timeout: 3_000, maxBuffer: 4_096 },
    );
    expect(stdout).toBe("decoded");
  });
});
