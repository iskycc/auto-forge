import { expect, type APIRequestContext } from "@playwright/test";
import { WebSocket } from "ws";

export async function openDistributedLogStream(
  request: APIRequestContext,
  endpoint: string,
  attemptId: string,
) {
  const ticketResponse = await request.post(
    `${endpoint}/api/v1/run-attempts/${attemptId}/log-stream-ticket`,
    { headers: { origin: endpoint } },
  );
  expect(ticketResponse.status()).toBe(200);
  const { ticket } = (await ticketResponse.json()) as { ticket: string };
  const socket = new WebSocket(
    endpoint.replace(/^http/, "ws") + "/api/v1/log-stream",
    [`autoforge-log.${ticket}`],
    { origin: endpoint },
  );
  const chunks: Array<{ sequence: number; content: string }> = [];
  let ready = false;
  let failure: Error | undefined;
  socket.on("error", (error) => {
    failure = error;
  });
  socket.on("message", (frame) => {
    const message = JSON.parse(frame.toString()) as {
      type: string;
      chunks?: Array<{ sequence: number; content: string }>;
    };
    if (message.type === "ready") ready = true;
    if (message.type === "chunks") chunks.push(...(message.chunks ?? []));
  });
  try {
    await expect
      .poll(
        () => {
          if (failure) throw failure;
          return ready;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  } catch (error) {
    socket.terminate();
    throw error;
  }
  return {
    chunks,
    async expectContent(sequence: number, content: string) {
      await expect
        .poll(
          () => {
            if (failure) throw failure;
            return chunks.some((chunk) => chunk.sequence === sequence && chunk.content === content);
          },
          { timeout: 15_000 },
        )
        .toBe(true);
    },
    close() {
      socket.terminate();
    },
  };
}
