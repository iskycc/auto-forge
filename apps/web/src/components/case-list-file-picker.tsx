"use client";

import { Upload } from "antd";
import { FileSpreadsheet } from "lucide-react";
import { MAX_CASE_LIST_FILE_BYTES, validateCaseListFileSize } from "@/lib/case-list-file";
import { useClientReadiness } from "./ui/use-client-readiness";

type CaseListFilePickerProps = {
  label: string;
  fileName?: string;
  disabled?: boolean;
  onSelect(file: File): void;
  onError(message: string): void;
};

export function CaseListFilePicker({
  label,
  fileName,
  disabled = false,
  onSelect,
  onError,
}: CaseListFilePickerProps) {
  const ready = useClientReadiness();
  const unavailable = !ready || disabled;

  return (
    <div
      className="min-w-0"
      onDropCapture={(event) => {
        if (unavailable || event.dataTransfer.files.length === 0) {
          event.preventDefault();
          event.stopPropagation();
          if (!unavailable) onError("请拖入一个用例清单文件，不支持文件夹或文本拖放。");
        }
      }}
    >
      <Upload.Dragger
        className="case-list-file-dropzone"
        classNames={{ root: "block min-w-0 [&_.ant-upload-btn]:table-fixed" }}
        aria-label={label}
        // Report unsupported files through the parser instead of silently ignoring a drop.
        accept={{ format: ".xlsx,.csv,.tsv,.txt", filter: "native" }}
        multiple
        fileList={[]}
        showUploadList={false}
        disabled={unavailable}
        beforeUpload={(file, selection) => {
          if (unavailable || file !== selection[0]) return Upload.LIST_IGNORE;
          if (selection.length !== 1) {
            onError("每次只能选择一个用例清单文件，请合并清单或分别导入。");
            return Upload.LIST_IGNORE;
          }
          try {
            validateCaseListFileSize(file);
          } catch (error) {
            onError(error instanceof Error ? error.message : "无法读取用例清单文件。");
            return Upload.LIST_IGNORE;
          }
          onSelect(file);
          // Selection stays local; matching starts only after explicit preview.
          return Upload.LIST_IGNORE;
        }}
      >
        <div className="grid min-w-0 justify-items-center gap-2 px-4 py-2">
          <FileSpreadsheet size={28} className="text-primary" aria-hidden="true" />
          <div className="min-w-0 w-full space-y-1" aria-live="polite">
            <p className="ui-file-name truncate font-medium text-foreground" title={fileName}>
              {fileName || "点击选择或拖入清单文件"}
            </p>
            <p className="text-xs text-muted-foreground">
              {fileName ? "点击或拖入新文件以更换" : "XLSX / CSV / TSV / TXT"}
            </p>
            <p className="text-xs text-muted-foreground">
              每次一个 · 最大 {MAX_CASE_LIST_FILE_BYTES / 1024 / 1024} MiB
            </p>
          </div>
        </div>
      </Upload.Dragger>
    </div>
  );
}
