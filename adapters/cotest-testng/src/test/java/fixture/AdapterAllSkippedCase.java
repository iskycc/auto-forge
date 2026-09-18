package fixture;

import org.testng.SkipException;
import org.testng.annotations.Test;

public final class AdapterAllSkippedCase {
  @Test
  public void skipped() {
    throw new SkipException("all tests skipped must fail the execution");
  }
}
