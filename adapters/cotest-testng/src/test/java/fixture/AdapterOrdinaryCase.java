package fixture;

import cotest.auto.dataproviders.MM2DataProvider;
import org.testng.annotations.Test;

public final class AdapterOrdinaryCase {
  static {
    if (MM2DataProvider.getDdtInsightUrl() != null) {
      throw new IllegalStateException("Ordinary cases must not receive a DDT API URL.");
    }
  }

  @Test
  public void doesNotReceiveDdtConfiguration() {
    if (MM2DataProvider.getClassDataProvider(getClass().getName()) != null) {
      throw new AssertionError("Ordinary cases must not receive a DDT CaseID.");
    }
  }
}
