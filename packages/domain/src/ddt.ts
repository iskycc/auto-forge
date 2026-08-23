export type DdtCellValue = string | number | boolean | null;

export type DdtCaseStep = Record<string, DdtCellValue>;
export type DdtJourneySteps = Record<string, DdtCaseStep>;
export type DdtCaseData = Record<string, DdtCellValue | DdtJourneySteps>;
export type DdtCaseKind = "standard" | "journey";

export const DDT_JOURNEY_FIELD = "用户旅程";

export type DdtScope = {
  projectId: string;
  projectVersionId: string;
  testStageId: string;
};

export type DdtCaseSummary = DdtScope & {
  id: string;
  caseId: string;
  srNum: string;
  kind: DdtCaseKind;
  sourceName: string;
  revision: number;
  updatedAt: string;
};

export type DdtCase = DdtCaseSummary & {
  data: DdtCaseData;
  createdAt: string;
  updatedBy?: string;
};

export type DdtHistoryChange = {
  field: string;
  beforeExists: boolean;
  afterExists: boolean;
  before: DdtCellValue | DdtJourneySteps | undefined;
  after: DdtCellValue | DdtJourneySteps | undefined;
};

export type DdtCaseHistory = {
  id: string;
  ddtCaseId: string;
  caseId: string;
  changeType: "edit" | "bulk_edit" | "import_overwrite" | "restore";
  actorId?: string;
  sourceName: string;
  changes: DdtHistoryChange[];
  before: DdtCaseData;
  after: DdtCaseData;
  createdAt: string;
};

export type DdtTemplateFieldType = "string" | "number" | "boolean" | "date";

export type DdtTemplateFieldRule = {
  field: string;
  required: boolean;
  type: DdtTemplateFieldType;
  enumValues?: DdtCellValue[];
  defaultValue?: DdtCellValue;
};

export type DdtCaseTemplate = DdtScope & {
  id: string;
  srNum: string;
  name: string;
  description: string;
  rules: DdtTemplateFieldRule[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
};

export type DdtValidationIssue = {
  field: string;
  code: "required" | "type" | "enum" | "case_id" | "sr_num";
  message: string;
};

export function normalizeDdtStepName(value: string): string | null {
  const match = /^step(\d+)$/i.exec(value.trim());
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? `step${number}` : null;
}

export function ddtStepNames(data: DdtCaseData): string[] {
  const steps = ddtJourneySteps(data);
  return steps
    ? Object.keys(steps).sort((left, right) => ddtStepNumber(left) - ddtStepNumber(right))
    : [];
}

export function ddtJourneySteps(data: DdtCaseData): DdtJourneySteps | null {
  const value = data[DDT_JOURNEY_FIELD];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as DdtJourneySteps;
}

export function isDdtJourney(data: DdtCaseData): boolean {
  return ddtJourneySteps(data) !== null;
}

export function ddtCaseCell(data: DdtCaseData, field: string): DdtCellValue {
  const direct = data[field];
  if (direct === null || ["string", "number", "boolean"].includes(typeof direct)) {
    return direct as DdtCellValue;
  }
  const firstStep = ddtJourneySteps(data)?.[ddtStepNames(data)[0] ?? ""];
  const value = firstStep?.[field];
  return value === undefined ? null : value;
}

export function createDdtJourney(
  caseId: string,
  srNum: string,
  steps: DdtJourneySteps,
): DdtCaseData {
  return {
    CaseID: caseId,
    srNum,
    [DDT_JOURNEY_FIELD]: synchronizeDdtJourney(steps, caseId, srNum),
  };
}

export function synchronizeDdtJourney(
  steps: DdtJourneySteps,
  caseId: string,
  srNum: string,
): DdtJourneySteps {
  return Object.fromEntries(
    Object.entries(steps).map(([name, step]) => [name, { ...step, CaseID: caseId, srNum }]),
  );
}

export function normalizeDdtCaseData(input: DdtCaseData): DdtCaseData {
  const caseId = String(ddtCaseCell(input, "CaseID") ?? "").trim();
  const srNum = String(ddtCaseCell(input, "srNum") ?? "").trim();
  if (!caseId) throw new Error("CaseID 不能为空。");
  if (caseId.length > 512) throw new Error("CaseID 不能超过 512 个字符。");
  if (/[\r\n\u0085\u2028\u2029]/u.test(caseId)) throw new Error("CaseID 不能包含换行符。");
  if (!srNum) throw new Error("srNum 不能为空。");
  if (srNum.length > 512) throw new Error("srNum 不能超过 512 个字符。");
  const steps = ddtJourneySteps(input);
  return steps ? createDdtJourney(caseId, srNum, steps) : { ...input, CaseID: caseId, srNum };
}

export function updateDdtCaseField(
  input: DdtCaseData,
  field: string,
  value: DdtCellValue,
  stepName?: string,
): DdtCaseData {
  const steps = ddtJourneySteps(input);
  if (!steps) {
    if (stepName) throw new Error("普通 DDT 用例不支持 Step 参数。");
    return normalizeDdtCaseData({ ...input, [field]: value });
  }
  const normalizedStep = normalizeDdtStepName(stepName ?? "");
  if (!normalizedStep || !steps[normalizedStep]) throw new Error("请选择有效的用户旅程 Step。");
  if (field === "CaseID" || field === "srNum") {
    const caseId = field === "CaseID" ? String(value ?? "") : String(ddtCaseCell(input, "CaseID"));
    const srNum = field === "srNum" ? String(value ?? "") : String(ddtCaseCell(input, "srNum"));
    return normalizeDdtCaseData(createDdtJourney(caseId, srNum, steps));
  }
  return normalizeDdtCaseData(
    createDdtJourney(String(ddtCaseCell(input, "CaseID")), String(ddtCaseCell(input, "srNum")), {
      ...steps,
      [normalizedStep]: { ...steps[normalizedStep], [field]: value },
    }),
  );
}

export function validateDdtCaseAgainstTemplate(
  input: DdtCaseData,
  template?: DdtCaseTemplate | null,
  applyDefaults = true,
): { data: DdtCaseData; errors: DdtValidationIssue[] } {
  let data: DdtCaseData;
  try {
    data = normalizeDdtCaseData(input);
  } catch (error) {
    return {
      data: input,
      errors: [
        {
          field: String(ddtCaseCell(input, "CaseID") ?? "").trim() ? "srNum" : "CaseID",
          code: String(ddtCaseCell(input, "CaseID") ?? "").trim() ? "sr_num" : "case_id",
          message: error instanceof Error ? error.message : "DDT 用例身份字段无效。",
        },
      ],
    };
  }
  if (!template) return { data, errors: [] };
  const errors: DdtValidationIssue[] = [];
  for (const rule of template.rules) {
    const current = data[rule.field];
    const empty =
      current === undefined ||
      current === null ||
      (typeof current === "string" && current.trim() === "");
    if (empty && applyDefaults && Object.hasOwn(rule, "defaultValue")) {
      data = { ...data, [rule.field]: rule.defaultValue ?? null };
      continue;
    }
    if (empty) {
      if (rule.required) {
        errors.push({
          field: rule.field,
          code: "required",
          message: `字段“${rule.field}”不能为空。`,
        });
      }
      continue;
    }
    if (typeof current === "object") {
      errors.push({ field: rule.field, code: "type", message: `字段“${rule.field}”类型不正确。` });
      continue;
    }
    if (!ddtValueMatchesType(current, rule.type)) {
      errors.push({
        field: rule.field,
        code: "type",
        message: `字段“${rule.field}”必须是${ddtTypeLabel(rule.type)}。`,
      });
    }
    if (rule.enumValues && !rule.enumValues.some((allowed) => Object.is(allowed, current))) {
      errors.push({
        field: rule.field,
        code: "enum",
        message: `字段“${rule.field}”不在允许值中。`,
      });
    }
  }
  return { data, errors };
}

export function diffDdtCaseData(before: DdtCaseData, after: DdtCaseData): DdtHistoryChange[] {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...fields].flatMap((field) => {
    const beforeExists = Object.hasOwn(before, field);
    const afterExists = Object.hasOwn(after, field);
    if (
      beforeExists === afterExists &&
      JSON.stringify(before[field]) === JSON.stringify(after[field])
    ) {
      return [];
    }
    return [
      {
        field,
        beforeExists,
        afterExists,
        before: before[field],
        after: after[field],
      },
    ];
  });
}

function ddtStepNumber(value: string): number {
  return Number(/^step(\d+)$/i.exec(value)?.[1] ?? Number.MAX_SAFE_INTEGER);
}

function ddtValueMatchesType(value: DdtCellValue, type: DdtTemplateFieldType): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value));
}

function ddtTypeLabel(type: DdtTemplateFieldType): string {
  return { string: "文本", number: "数字", boolean: "布尔值", date: "日期" }[type];
}
