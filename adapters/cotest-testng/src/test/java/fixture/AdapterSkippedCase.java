package fixture;

import org.testng.SkipException;
import org.testng.annotations.Test;

/** 一个通过一个跳过：TestNG 的 getStatus() 位图会带上跳过位，但执行不应被视为失败。 */
public final class AdapterSkippedCase {
  @Test
  public void passes() {}

  @Test
  public void skipped() {
    throw new SkipException("deliberate skip to exercise the TestNG status bitmap");
  }
}
