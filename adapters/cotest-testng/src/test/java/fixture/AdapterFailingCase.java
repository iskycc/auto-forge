package fixture;

import org.testng.Assert;
import org.testng.annotations.Test;

public final class AdapterFailingCase {
  @Test
  public void failsWithMultilineChineseMessage() {
    Assert.assertTrue(false, "中文断言失败 mixed English\n第二行错误详情 OrderId 不能为空");
  }
}
