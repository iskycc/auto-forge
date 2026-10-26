import { z } from "zod";

export const memoryAdmissionModeSchema = z.enum(["reserved", "threshold", "disabled"]);
export type MemoryAdmissionMode = z.infer<typeof memoryAdmissionModeSchema>;
