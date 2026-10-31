import { expect, it } from "vitest";
import { appendDdtUploadFiles } from "./ddt-upload-selection";

it("retains consecutive single drops and mixed multiple selections without duplicate files", () => {
  const a = { name: "a.xlsx", size: 12, lastModified: 1 };
  const b = { name: "b.xlsx", size: 24, lastModified: 2 };
  const changed = { ...a, lastModified: 3 };
  expect(appendDdtUploadFiles(appendDdtUploadFiles([], [a]), [b, a, changed])).toEqual([
    a,
    b,
    changed,
  ]);
  expect(appendDdtUploadFiles([a, b], [])).toEqual([a, b]);
});
