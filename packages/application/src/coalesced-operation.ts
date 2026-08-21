/**
 * 将同一 key 的并发请求合并为一次先导执行；执行期间新增的请求再合并为一次尾随执行。
 * 这样既抑制突发扫描，也不会丢掉先导执行读取快照之后提交的状态变化。
 */
export class CoalescedOperation<Result> {
  private requestedGeneration = 1;
  private completedGeneration = 0;
  readonly result: Promise<Result>;

  constructor(operation: () => Promise<Result>) {
    this.result = this.run(operation);
  }

  requestAnotherPass(): Promise<Result> {
    this.requestedGeneration += 1;
    return this.result;
  }

  private async run(operation: () => Promise<Result>): Promise<Result> {
    let latest: Result | undefined;
    do {
      const generation = this.requestedGeneration;
      latest = await operation();
      this.completedGeneration = generation;
    } while (this.completedGeneration < this.requestedGeneration);
    return latest;
  }
}
