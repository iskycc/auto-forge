import { z } from "zod";
import buildMetadata from "./platform-build-info.json";

// The image builder stamps this file before Next compiles it into the application.
// Workspace package versions and embedded Runner versions are independent identities.
export const platformBuild = z
  .object({
    version: z.string().min(1),
    kind: z.enum(["release", "development"]),
    revision: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    createdAt: z.string().datetime().optional(),
  })
  .parse(buildMetadata);

export const platformVersion = platformBuild.version;
