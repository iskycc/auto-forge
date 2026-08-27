export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // 启动期注册执行机协议快路径桥接器并预热平台服务：组合根快路径直接读取
  // globalThis 记忆化的桥接器与服务实例，未就绪时首批请求回退 Next.js 路由。
  // 初始化失败不阻塞启动，首个业务请求会看到与今天一致的失败语义。
  const { registerRunnerFastPathBridge } = await import("./lib/runner-fast-path-bridge");
  registerRunnerFastPathBridge();
  const { getPlatformServices } = await import("./lib/services");
  void getPlatformServices().catch(() => {});
}
