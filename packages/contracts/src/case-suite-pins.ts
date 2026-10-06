import { z } from "zod";

export const setCaseSuitePinInputSchema = z.object({ pinned: z.boolean() }).strict();
export type SetCaseSuitePinInput = z.infer<typeof setCaseSuitePinInputSchema>;
