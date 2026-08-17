package com.autoforge.javacases;

/** java-cases 模块共享常量；环境地址仅作为 mock 值参与注入断言。 */
public final class JavaCasesConstants {
  /** 任务"环境 IP / 地址"中的 mock 值，Adapter 按轮询分配给本用例。 */
  public static final String ENVIRONMENT_ADDRESS = "10.20.30.40";

  private JavaCasesConstants() {}
}
