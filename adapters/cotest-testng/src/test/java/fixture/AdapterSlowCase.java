package fixture;

import org.testng.annotations.Test;

public final class AdapterSlowCase {
  @Test
  public void sleepsLongerThanTheCaseTimeout() throws InterruptedException {
    Thread.sleep(30_000);
  }
}
