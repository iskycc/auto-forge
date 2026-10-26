import type { MemoryAdmissionMode } from "@autoforge/contracts";

export const memoryAdmissionLabels: Record<MemoryAdmissionMode, string> = {
  reserved: "阈值与预留（默认）",
  threshold: "仅按内存使用率",
  disabled: "不限制内存",
};

export const memoryAdmissionDescriptions: Record<MemoryAdmissionMode, string> = {
  reserved: "检查内存使用率，保留系统预算和用例增长空间；没有可靠占用采集时完整预留。",
  threshold: "兼容 SLES 12 等旧节点，不依赖 cgroup v2；仅检查内存使用率，不扣除每例预留预算。",
  disabled:
    "跳过内存使用率和预留预算限制。节点仍可能 OOM；CPU、节点槽位、任务和项目并发上限继续生效。",
};
