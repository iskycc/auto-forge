import { z } from "zod";

export const runnerRejectedContactSchema = z.object({
  runnerId: z.string().min(1).max(128),
  name: z.string().max(256),
  agentVersion: z.string().max(128),
  purgedAt: z.string(),
  firstRejectedAt: z.string(),
  lastRejectedAt: z.string(),
});
export const runnerRejectedContactsPageSchema = z.object({
  items: z.array(runnerRejectedContactSchema).max(100),
  nextCursor: z.string().max(128).optional(),
});
export type RunnerRejectedContact = z.infer<typeof runnerRejectedContactSchema>;
export type RunnerRejectedContactsPage = z.infer<typeof runnerRejectedContactsPageSchema>;
