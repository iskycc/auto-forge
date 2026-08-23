import { crc32, inflateRaw } from "node:zlib";
import { isSupportedSpreadsheetFile } from "./spreadsheet";

export interface ExtractedSpreadsheet {
  fileName: string;
  archiveEntryName: string;
  buffer: Buffer;
}

interface ExtractZipOptions {
  archiveName: string;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxEntries: number;
}

interface CentralDirectoryInfo {
  offset: number;
  size: number;
  entries: number;
}

interface ZipExtraField {
  id: number;
  data: Uint8Array;
}

interface ZipDirectoryEntry {
  name: string;
  rawName: Uint8Array;
  flags: number;
  compression: number;
  checksum: number;
  compressedSize: number;
  originalSize: number;
  localHeaderOffset: number;
  unicodePath?: string;
}

interface SelectedZipEntry {
  entry: ZipDirectoryEntry;
  path: { normalized: string; parts: string[] };
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_END_LOCATOR = 0x07064b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_EXTRA_FIELD = 0x0001;
const UNICODE_PATH_EXTRA_FIELD = 0x7075;
const UTF8_NAME_FLAG = 0x0800;
const ENCRYPTED_FLAG = 0x0001;
const MAX_ENTRY_NAME_CODE_POINTS = 1024;
const CP437_EXTENDED =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const gb18030Decoder = new TextDecoder("gb18030", { fatal: true });

class ZipImportError extends Error {}

function invalidZip(message = "ZIP 目录结构损坏") {
  return new ZipImportError(message);
}

function ensureRange(data: Uint8Array, offset: number, length: number) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > data.byteLength
  ) {
    throw invalidZip();
  }
}

function readUint16(data: Uint8Array, offset: number) {
  ensureRange(data, offset, 2);
  return data[offset]! | (data[offset + 1]! << 8);
}

function readUint32(data: Uint8Array, offset: number) {
  ensureRange(data, offset, 4);
  return (
    (data[offset]! |
      (data[offset + 1]! << 8) |
      (data[offset + 2]! << 16) |
      (data[offset + 3]! << 24)) >>>
    0
  );
}

function readUint64(data: Uint8Array, offset: number) {
  const value = BigInt(readUint32(data, offset)) | (BigInt(readUint32(data, offset + 4)) << 32n);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalidZip("ZIP64 数值超过当前运行环境可安全处理的范围");
  }
  return Number(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function parseExtraFields(data: Uint8Array) {
  const fields: ZipExtraField[] = [];
  let offset = 0;
  while (offset < data.byteLength) {
    if (offset + 4 > data.byteLength) throw invalidZip();
    const id = readUint16(data, offset);
    const size = readUint16(data, offset + 2);
    const valueOffset = offset + 4;
    ensureRange(data, valueOffset, size);
    fields.push({ id, data: data.subarray(valueOffset, valueOffset + size) });
    offset = valueOffset + size;
  }
  return fields;
}

function strictUtf8(data: Uint8Array) {
  return utf8Decoder.decode(data);
}

function unicodePathFromExtra(rawName: Uint8Array, fields: ZipExtraField[]) {
  for (const field of fields) {
    if (
      field.id !== UNICODE_PATH_EXTRA_FIELD ||
      field.data.byteLength < 5 ||
      field.data[0] !== 1 ||
      readUint32(field.data, 1) !== crc32(rawName)
    ) {
      continue;
    }

    try {
      return strictUtf8(field.data.subarray(5));
    } catch {
      // A malformed optional Unicode Path field is ignored. The raw name is
      // still decoded according to its ZIP flags or a compatible fallback.
    }
  }
  return undefined;
}

function isStructuredGb18030(data: Uint8Array) {
  let hasMultibyte = false;
  for (let index = 0; index < data.byteLength; index += 1) {
    const first = data[index]!;
    if (first <= 0x7f) continue;
    if (first < 0x81 || first > 0xfe || index + 1 >= data.byteLength) {
      return false;
    }

    const second = data[index + 1]!;
    if (
      second >= 0x30 &&
      second <= 0x39 &&
      index + 3 < data.byteLength &&
      data[index + 2]! >= 0x81 &&
      data[index + 2]! <= 0xfe &&
      data[index + 3]! >= 0x30 &&
      data[index + 3]! <= 0x39
    ) {
      hasMultibyte = true;
      index += 3;
      continue;
    }
    if (second >= 0x40 && second <= 0xfe && second !== 0x7f) {
      hasMultibyte = true;
      index += 1;
      continue;
    }
    return false;
  }
  return hasMultibyte;
}

function containsCjk(value: string) {
  return /\p{Script=Han}|[\u2e80-\u303f\u3040-\u30ff\uff00-\uffef]/u.test(value);
}

function decodeCp437(data: Uint8Array) {
  let value = "";
  for (const byte of data) {
    value += byte < 0x80 ? String.fromCharCode(byte) : CP437_EXTENDED[byte - 0x80];
  }
  return value;
}

function decodeEntryName(rawName: Uint8Array, flags: number, unicodePath?: string) {
  if (flags & UTF8_NAME_FLAG) {
    try {
      return strictUtf8(rawName);
    } catch {
      throw invalidZip("ZIP 中包含无效的 UTF-8 文件名");
    }
  }
  if (unicodePath !== undefined) return unicodePath;

  let decodedUtf8: string | undefined;
  try {
    decodedUtf8 = strictUtf8(rawName);
  } catch {
    // Some Windows ZIP tools omit the UTF-8 flag; legacy encodings are tried
    // only after strict UTF-8 fails.
  }

  let decodedGb18030: string | undefined;
  if (isStructuredGb18030(rawName)) {
    try {
      const decoded = gb18030Decoder.decode(rawName);
      if (containsCjk(decoded)) decodedGb18030 = decoded;
    } catch {
      // Fall through to the ZIP specification's legacy CP437 encoding.
    }
  }
  if (decodedUtf8 !== undefined) {
    // Some GBK pairs are also valid UTF-8 sequences (for example 路=C2 B7
    // and 茅=C3 A9). When only the GB18030 interpretation contains CJK,
    // prefer the Chinese Windows encoding used by legacy ZIP tools.
    if (!containsCjk(decodedUtf8) && decodedGb18030 !== undefined) {
      return decodedGb18030;
    }
    return decodedUtf8;
  }
  if (decodedGb18030 !== undefined) return decodedGb18030;
  return decodeCp437(rawName);
}

function findEndOfCentralDirectory(data: Uint8Array) {
  if (data.byteLength < 22) throw invalidZip("无法解压 ZIP，请确认压缩包未损坏");
  const minimumOffset = Math.max(0, data.byteLength - 22 - 0xffff);
  for (let offset = data.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (readUint32(data, offset) !== END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = readUint16(data, offset + 20);
    if (offset + 22 + commentLength === data.byteLength) return offset;
  }
  throw invalidZip("无法解压 ZIP，请确认压缩包未损坏");
}

function centralDirectoryInfo(data: Uint8Array, maxEntries: number): CentralDirectoryInfo {
  const endOffset = findEndOfCentralDirectory(data);
  let diskNumber = readUint16(data, endOffset + 4);
  let directoryDisk = readUint16(data, endOffset + 6);
  let entriesOnDisk = readUint16(data, endOffset + 8);
  let entries = readUint16(data, endOffset + 10);
  let size = readUint32(data, endOffset + 12);
  let offset = readUint32(data, endOffset + 16);
  const needsZip64 =
    entriesOnDisk === 0xffff || entries === 0xffff || size === 0xffffffff || offset === 0xffffffff;

  if (needsZip64) {
    const locatorOffset = endOffset - 20;
    if (locatorOffset < 0 || readUint32(data, locatorOffset) !== ZIP64_END_LOCATOR) {
      throw invalidZip("ZIP64 目录结构损坏");
    }
    const zip64Disk = readUint32(data, locatorOffset + 4);
    const zip64Offset = readUint64(data, locatorOffset + 8);
    const totalDisks = readUint32(data, locatorOffset + 16);
    ensureRange(data, zip64Offset, 56);
    if (readUint32(data, zip64Offset) !== ZIP64_END_OF_CENTRAL_DIRECTORY) {
      throw invalidZip("ZIP64 目录结构损坏");
    }
    const recordSize = readUint64(data, zip64Offset + 4);
    if (recordSize < 44 || zip64Offset + 12 + recordSize !== locatorOffset) {
      throw invalidZip("ZIP64 目录结构损坏");
    }
    ensureRange(data, zip64Offset, 12 + recordSize);
    diskNumber = readUint32(data, zip64Offset + 16);
    directoryDisk = readUint32(data, zip64Offset + 20);
    entriesOnDisk = readUint64(data, zip64Offset + 24);
    entries = readUint64(data, zip64Offset + 32);
    size = readUint64(data, zip64Offset + 40);
    offset = readUint64(data, zip64Offset + 48);
    if (zip64Disk !== 0 || totalDisks !== 1) {
      throw invalidZip("不支持分卷 ZIP 压缩包");
    }
  }

  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entries) {
    throw invalidZip("不支持分卷 ZIP 压缩包");
  }
  if (entries > maxEntries) {
    throw new ZipImportError(`ZIP 内条目过多，最多检查 ${maxEntries} 个条目`);
  }
  ensureRange(data, offset, size);
  if (offset + size > endOffset) throw invalidZip();
  return { offset, size, entries };
}

function zip64EntryValues(
  fields: ZipExtraField[],
  rawOriginalSize: number,
  rawCompressedSize: number,
  rawLocalHeaderOffset: number,
  rawDiskNumber: number,
) {
  let originalSize = rawOriginalSize;
  let compressedSize = rawCompressedSize;
  let localHeaderOffset = rawLocalHeaderOffset;
  let diskNumber = rawDiskNumber;
  const needsZip64 =
    originalSize === 0xffffffff ||
    compressedSize === 0xffffffff ||
    localHeaderOffset === 0xffffffff ||
    diskNumber === 0xffff;
  if (!needsZip64) {
    return { originalSize, compressedSize, localHeaderOffset, diskNumber };
  }

  const zip64 = fields.find((field) => field.id === ZIP64_EXTRA_FIELD)?.data;
  if (!zip64) throw invalidZip("ZIP64 条目缺少大小或偏移信息");
  let offset = 0;
  if (originalSize === 0xffffffff) {
    originalSize = readUint64(zip64, offset);
    offset += 8;
  }
  if (compressedSize === 0xffffffff) {
    compressedSize = readUint64(zip64, offset);
    offset += 8;
  }
  if (localHeaderOffset === 0xffffffff) {
    localHeaderOffset = readUint64(zip64, offset);
    offset += 8;
  }
  if (diskNumber === 0xffff) diskNumber = readUint32(zip64, offset);
  return { originalSize, compressedSize, localHeaderOffset, diskNumber };
}

function readDirectoryEntries(data: Uint8Array, maxEntries: number) {
  const directory = centralDirectoryInfo(data, maxEntries);
  const directoryEnd = directory.offset + directory.size;
  const entries: ZipDirectoryEntry[] = [];
  let offset = directory.offset;

  for (let ordinal = 0; ordinal < directory.entries; ordinal += 1) {
    ensureRange(data, offset, 46);
    if (readUint32(data, offset) !== CENTRAL_DIRECTORY_HEADER) {
      throw invalidZip();
    }
    const flags = readUint16(data, offset + 8);
    const compression = readUint16(data, offset + 10);
    const checksum = readUint32(data, offset + 16);
    const rawCompressedSize = readUint32(data, offset + 20);
    const rawOriginalSize = readUint32(data, offset + 24);
    const nameLength = readUint16(data, offset + 28);
    const extraLength = readUint16(data, offset + 30);
    const commentLength = readUint16(data, offset + 32);
    const rawDiskNumber = readUint16(data, offset + 34);
    const rawLocalHeaderOffset = readUint32(data, offset + 42);
    const nameOffset = offset + 46;
    const extraOffset = nameOffset + nameLength;
    const nextOffset = extraOffset + extraLength + commentLength;
    if (nextOffset > directoryEnd) throw invalidZip();

    const rawName = data.subarray(nameOffset, extraOffset);
    const fields = parseExtraFields(data.subarray(extraOffset, extraOffset + extraLength));
    const sizes = zip64EntryValues(
      fields,
      rawOriginalSize,
      rawCompressedSize,
      rawLocalHeaderOffset,
      rawDiskNumber,
    );
    if (sizes.diskNumber !== 0) throw invalidZip("不支持分卷 ZIP 压缩包");
    const unicodePath = unicodePathFromExtra(rawName, fields);
    entries.push({
      name: decodeEntryName(rawName, flags, unicodePath).normalize("NFC"),
      rawName,
      flags,
      compression,
      checksum,
      compressedSize: sizes.compressedSize,
      originalSize: sizes.originalSize,
      localHeaderOffset: sizes.localHeaderOffset,
      ...(unicodePath ? { unicodePath } : {}),
    });
    offset = nextOffset;
  }
  if (offset > directoryEnd) throw invalidZip();
  return { entries, directoryOffset: directory.offset };
}

function normalizedEntryName(value: string) {
  let normalized = value.normalize("NFC").replaceAll("\\", "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
}

function entryPathParts(value: string) {
  const normalized = normalizedEntryName(value);
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069\ufffd]/u.test(normalized) ||
    Array.from(normalized).length > MAX_ENTRY_NAME_CODE_POINTS
  ) {
    return null;
  }

  const parts = normalized.split("/");
  if (
    parts.some((part) => !part || part === "." || part === "..") ||
    parts.some((part) => part === "__MACOSX") ||
    parts.at(-1)?.startsWith("._")
  ) {
    return null;
  }

  return { normalized, parts };
}

function displayArchiveName(value: string) {
  const basename = value
    .replace(/(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF])/g, "�")
    .normalize("NFC")
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .at(-1);
  const cleaned = (basename || "导入压缩包.zip").replace(
    /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069\ufffd]/gu,
    "_",
  );
  return Array.from(cleaned).slice(0, 255).join("");
}

function readLocalHeader(archive: Uint8Array, entry: ZipDirectoryEntry, directoryOffset: number) {
  const offset = entry.localHeaderOffset;
  ensureRange(archive, offset, 30);
  if (readUint32(archive, offset) !== LOCAL_FILE_HEADER) throw invalidZip();
  const localFlags = readUint16(archive, offset + 6);
  const localCompression = readUint16(archive, offset + 8);
  const nameLength = readUint16(archive, offset + 26);
  const extraLength = readUint16(archive, offset + 28);
  const nameOffset = offset + 30;
  const extraOffset = nameOffset + nameLength;
  const dataOffset = extraOffset + extraLength;
  ensureRange(archive, nameOffset, nameLength + extraLength);
  ensureRange(archive, dataOffset, entry.compressedSize);
  if (dataOffset + entry.compressedSize > directoryOffset) throw invalidZip();
  if (
    localCompression !== entry.compression ||
    (localFlags & (ENCRYPTED_FLAG | UTF8_NAME_FLAG)) !==
      (entry.flags & (ENCRYPTED_FLAG | UTF8_NAME_FLAG)) ||
    !equalBytes(archive.subarray(nameOffset, nameOffset + nameLength), entry.rawName)
  ) {
    throw invalidZip("ZIP 本地文件头与中央目录不一致");
  }

  const fields = parseExtraFields(archive.subarray(extraOffset, extraOffset + extraLength));
  const localUnicodePath = unicodePathFromExtra(entry.rawName, fields);
  if (
    localUnicodePath !== undefined &&
    entry.unicodePath !== undefined &&
    localUnicodePath.normalize("NFC") !== entry.unicodePath.normalize("NFC")
  ) {
    throw invalidZip("ZIP 文件名的 Unicode 元数据相互冲突");
  }
  return {
    compressed: archive.subarray(dataOffset, dataOffset + entry.compressedSize),
  };
}

function inflateEntry(data: Uint8Array, maxOutputLength: number) {
  return new Promise<Buffer>((resolve, reject) => {
    inflateRaw(data, { maxOutputLength: Math.max(1, maxOutputLength) }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

async function extractEntry(
  archive: Uint8Array,
  selected: SelectedZipEntry,
  directoryOffset: number,
  maxFileBytes: number,
) {
  const { entry, path } = selected;
  if (entry.flags & ENCRYPTED_FLAG) {
    throw new ZipImportError(`ZIP 中的 ${path.normalized} 已加密，无法导入`);
  }
  if (entry.compression !== 0 && entry.compression !== 8) {
    throw new ZipImportError(`ZIP 中的 ${path.normalized} 使用了不支持的压缩算法`);
  }
  if (entry.compression === 0 && entry.compressedSize !== entry.originalSize) {
    throw new ZipImportError(`ZIP 中的 ${path.normalized} 存储大小与目录记录不一致`);
  }
  const { compressed } = readLocalHeader(archive, entry, directoryOffset);
  let output: Buffer;
  if (entry.compression === 0) {
    output = Buffer.from(compressed);
  } else {
    try {
      output = await inflateEntry(compressed, Math.min(entry.originalSize, maxFileBytes));
    } catch {
      throw new ZipImportError(
        `无法解压 ZIP 中的 ${path.normalized}，文件可能已损坏或超过大小上限`,
      );
    }
  }
  if (output.byteLength !== entry.originalSize) {
    throw new ZipImportError(`ZIP 中的 ${path.normalized} 解压大小与目录记录不一致`);
  }
  if (output.byteLength > maxFileBytes) {
    throw new ZipImportError(`ZIP 中的 ${path.normalized} 解压后超过单文件大小上限`);
  }
  if (crc32(output) !== entry.checksum) {
    throw new ZipImportError(`ZIP 中的 ${path.normalized} 校验失败，文件可能已损坏`);
  }
  return output;
}

export function isZipFile(fileName: string) {
  return fileName.toLocaleLowerCase("en-US").endsWith(".zip");
}

export async function extractSpreadsheetsFromZip(archive: Buffer, options: ExtractZipOptions) {
  let directory: ReturnType<typeof readDirectoryEntries>;
  try {
    directory = readDirectoryEntries(archive, options.maxEntries);
  } catch (error) {
    if (error instanceof ZipImportError) throw error;
    throw invalidZip("无法解压 ZIP，请确认压缩包未损坏");
  }

  const selected: SelectedZipEntry[] = [];
  const selectedPaths = new Set<string>();
  let declaredBytes = 0;
  for (const entry of directory.entries) {
    const isDirectory = entry.name.endsWith("/") || entry.name.endsWith("\\");
    if (isDirectory) continue;
    const path = entryPathParts(entry.name);
    if (!path) {
      if (isSupportedSpreadsheetFile(entry.name)) {
        throw new ZipImportError("ZIP 中包含无效的表格文件路径");
      }
      continue;
    }
    if (path.parts.length > 2 || !isSupportedSpreadsheetFile(path.normalized)) {
      continue;
    }
    if (selectedPaths.has(path.normalized)) {
      throw new ZipImportError(`ZIP 中包含重名表格：${path.normalized}`);
    }
    if (selected.length >= options.maxFiles) {
      throw new ZipImportError("ZIP 中可导入的表格超过本次剩余额度");
    }
    if (entry.originalSize > options.maxFileBytes) {
      throw new ZipImportError(`ZIP 中的 ${path.normalized} 解压后超过单文件大小上限`);
    }
    if (declaredBytes + entry.originalSize > options.maxTotalBytes) {
      throw new ZipImportError("ZIP 解压后的表格总大小超过允许上限");
    }
    selectedPaths.add(path.normalized);
    selected.push({ entry, path });
    declaredBytes += entry.originalSize;
  }

  if (!selected.length) {
    throw new ZipImportError("ZIP 根目录或一层子目录中未找到支持的表格，未执行导入");
  }

  const extracted: ExtractedSpreadsheet[] = [];
  const archiveName = displayArchiveName(options.archiveName);
  let actualBytes = 0;
  for (const item of selected) {
    const output = await extractEntry(
      archive,
      item,
      directory.directoryOffset,
      options.maxFileBytes,
    );
    actualBytes += output.byteLength;
    if (actualBytes > options.maxTotalBytes) {
      throw new ZipImportError("ZIP 解压后的表格总大小超过允许上限");
    }
    extracted.push({
      fileName: `${archiveName} / ${item.path.normalized}`,
      archiveEntryName: item.path.normalized,
      buffer: output,
    });
  }
  return extracted;
}
