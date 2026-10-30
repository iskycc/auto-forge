import { z } from "zod";

export const batchSchedulingControlSchema = z
  .object({ action: z.enum(["pause", "resume"]) })
  .strict();
