import type { DdtImportRowShape } from "@autoforge/contracts";
import {
  DDT_JOURNEY_FIELD,
  ddtJourneySteps,
  isDdtJourney,
  type DdtCaseData,
  type DdtCaseStep,
} from "@autoforge/domain";

/** Restore the original rectangular-sheet semantics only for the current case. */
export function materializeDdtImportRow(row: DdtCaseData, shape?: DdtImportRowShape): DdtCaseData {
  return createDdtImportRowReader(shape)(row);
}

export function createDdtImportRowReader(
  shape?: DdtImportRowShape,
): (row: DdtCaseData) => DdtCaseData {
  if (!shape) return (row) => row;
  const standard = emptyColumns(shape.standard);
  const steps = new Map(
    Object.entries(shape.steps).map(([name, columns]) => [name, emptyColumns(columns)]),
  );
  return (row) => {
    if (!isDdtJourney(row)) return { ...standard, ...row };
    return {
      ...row,
      [DDT_JOURNEY_FIELD]: Object.fromEntries(
        Object.entries(ddtJourneySteps(row) ?? {}).map(([name, values]) => [
          name,
          { ...steps.get(name), ...values },
        ]),
      ),
    };
  };
}

function emptyColumns(columns: readonly string[]): DdtCaseStep {
  return Object.fromEntries(columns.map((column) => [column, ""]));
}
