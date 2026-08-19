package fixture;

import org.testng.annotations.Test;

public final class AdapterFailingCase {
  @Test
  public void failsWithMultilineChineseMessage() {
    throw new AssertionError("中文断言失败\n第二行错误详情");
  }
}
