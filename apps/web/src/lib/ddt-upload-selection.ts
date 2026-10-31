type SelectedFile = Pick<File, "name" | "size" | "lastModified">;

export function ddtUploadFileKey(file: SelectedFile): string {
  return JSON.stringify([file.name, file.size, file.lastModified]);
}

/** Repeated picker/drop events append files while retaining the previous selection order. */
export function appendDdtUploadFiles<FileType extends SelectedFile>(
  current: readonly FileType[],
  added: readonly FileType[],
): FileType[] {
  const keys = new Set(current.map(ddtUploadFileKey));
  return [
    ...current,
    ...added.filter((file) => {
      const key = ddtUploadFileKey(file);
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    }),
  ];
}
