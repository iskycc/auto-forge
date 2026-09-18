package fixture;

import org.testng.SkipException;
import org.testng.annotations.Test;

/** 一个通过一个跳过：即使有成功方法，整个执行仍应失败。 */
public final class AdapterSkippedCase {
  @Test
  public void passes() {}

  @Test
  public void skipped() {
    throw new SkipException("deliberate skip to exercise the TestNG status bitmap");
  }
}
