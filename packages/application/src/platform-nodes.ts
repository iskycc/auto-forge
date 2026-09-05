import type { PlatformNode } from "@autoforge/contracts";

export interface PlatformNodeRepository {
  list(afterId?: string): Promise<{ items: PlatformNode[]; nextCursor?: string }>;
  find(id: string): Promise<PlatformNode | null>;
  register(id: string, now: string): Promise<void>;
  update(
    id: string,
    input: Pick<PlatformNode, "name" | "internalBaseUrl" | "revision">,
    now: string,
  ): Promise<PlatformNode>;
}
