import { uploadPercent } from "./upload-with-progress";

export function readFileWithProgress(
  file: File,
  onProgress: (percent: number) => void,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(uploadPercent(event.loaded, event.total));
      }
    };
    reader.onload = () => {
      onProgress(100);
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error("浏览器未能读取所选文件。"));
    };
    reader.onerror = () => reject(new Error("读取用例列表失败，请重新选择文件。"));
    reader.onabort = () => reject(new Error("用例列表读取已取消。"));
    reader.readAsArrayBuffer(file);
  });
}
