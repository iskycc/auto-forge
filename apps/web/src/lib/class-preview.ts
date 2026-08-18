import type { JarInspection } from "@autoforge/contracts";

/**
 * 扫描预览逐条展示上限。超过该数量时页面只保留统计计数与识别警告：
 * 数千个折叠 <details> 既渲染缓慢，也让列表看起来是一片没有内容的空白行，
 * 反而看不出导入了哪些用例；此时逐条预览已失去人工核对价值。
 */
export const CLASS_PREVIEW_LIMIT = 100;

export type InspectionClassPreview = JarInspection["classes"][number];

/**
 * discovery 可能对同一 className 产生重复候选（如 Multi-Release JAR 条目）。
 * 重复 key 会让 React reconciliation 错乱（表现为空白行），渲染前按
 * className 去重并保留首个候选。
 */
export function uniqueInspectionClasses(
  classes: readonly InspectionClassPreview[],
): InspectionClassPreview[] {
  const seen = new Set<string>();
  return classes.filter((candidate) => {
    if (seen.has(candidate.className)) return false;
    seen.add(candidate.className);
    return true;
  });
}
