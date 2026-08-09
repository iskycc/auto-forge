import type { CaseDefinitionWithMethods } from "./case-definition";

export type CaseSuite = {
  id: string;
  name: string;
  description?: string;
  version: number;
  caseCount: number;
  createdAt: string;
  updatedAt: string;
};

export type CaseSuiteItem = {
  id: string;
  suiteId: string;
  caseDefinition: CaseDefinitionWithMethods;
  addedAt: string;
};

export type CaseSuiteDetails = CaseSuite & {
  items: CaseSuiteItem[];
};
