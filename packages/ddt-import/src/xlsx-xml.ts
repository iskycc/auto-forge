import { TextDecoder } from "node:util";
import { SaxesParser, type SaxesTagPlain } from "saxes";
import type { SpreadsheetZip } from "./archive";

export type XmlHandlers = {
  open?(tag: SaxesTagPlain, name: string): void;
  close?(name: string): void;
  text?(value: string): void;
};

export async function readXlsxXml(archive: SpreadsheetZip, path: string, handlers: XmlHandlers) {
  const parser = new SaxesParser({ xmlns: false });
  parser.on("doctype", () => {
    throw new Error("XLSX 不允许包含 XML 文档类型声明");
  });
  parser.on("opentag", (tag) => handlers.open?.(tag, localXmlName(tag.name)));
  parser.on("closetag", (tag) => handlers.close?.(localXmlName(tag.name)));
  parser.on("text", (value) => handlers.text?.(value));
  parser.on("cdata", (value) => handlers.text?.(value));
  let decoder: TextDecoder | undefined;
  try {
    for await (const chunk of archive.readChunks(path)) {
      decoder ??= new TextDecoder(
        (chunk[0] === 0xff && chunk[1] === 0xfe) || (chunk[0] === 0x3c && chunk[1] === 0)
          ? "utf-16le"
          : (chunk[0] === 0xfe && chunk[1] === 0xff) || (chunk[0] === 0 && chunk[1] === 0x3c)
            ? "utf-16be"
            : "utf-8",
        { fatal: true },
      );
      parser.write(decoder.decode(chunk, { stream: true }));
    }
    parser.write(decoder?.decode() ?? "").close();
  } catch (cause) {
    throw new Error(
      `无法解析 XLSX 内部文件 ${path}：${cause instanceof Error ? cause.message : "格式错误"}`,
      { cause },
    );
  }
}

export function localXmlName(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1);
}

/** Decode Excel's escaped UTF-16 units once, including escaped literal underscores. */
export function xlsxText(value: string): string {
  const decoded = value
    .replace(/_x([0-9a-f]{4})_/gi, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\r\n/g, "\n");
  // SAX text may be a slice retaining the whole decoded XML chunk. Detach
  // retained values; UTF-16 preserves every code unit, including escaped units.
  return Buffer.from(decoded, "utf16le").toString("utf16le");
}
