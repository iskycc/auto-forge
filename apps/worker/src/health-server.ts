import { createServer, type Server } from "node:http";

export type WorkerHealth = {
  ready: boolean;
  checkDependencies(): Promise<void>;
  metricsEnabled: boolean;
  readMetrics(): Promise<string>;
};

export async function startHealthServer(port: number, health: WorkerHealth): Promise<Server> {
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/health/live") {
      response.writeHead(200).end(JSON.stringify({ status: "live" }));
      return;
    }
    if (request.url === "/health/ready") {
      try {
        if (!health.ready) throw new Error("Worker is not accepting work.");
        await withTimeout(health.checkDependencies(), 2_000);
        response.writeHead(200).end(JSON.stringify({ status: "ready" }));
      } catch {
        response.writeHead(503).end(JSON.stringify({ status: "not_ready" }));
      }
      return;
    }
    if (request.url === "/metrics" && health.metricsEnabled) {
      try {
        const metrics = await withTimeout(health.readMetrics(), 2_000);
        response.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
        response.writeHead(200).end(metrics);
      } catch {
        response.writeHead(503).end("# worker metrics unavailable\n");
      }
      return;
    }
    response.writeHead(404).end(JSON.stringify({ code: "NOT_FOUND" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    operation,
    new Promise<T>((_resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Health check timed out.")), timeoutMs);
      timeout.unref();
    }),
  ]);
}

export async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
