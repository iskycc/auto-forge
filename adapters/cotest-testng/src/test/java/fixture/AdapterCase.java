package fixture;

import com.huawei.cotest.util.ProjectFileUtil;
import cotest.auto.dataproviders.MM2DataProvider;
import org.testng.annotations.Test;

public final class AdapterCase {
  public static final String EXPECTED_ENVIRONMENT_ADDRESS = "10.0.0.8";

  @Test
  public void receivesAdapterConfiguration() {
    if (!EXPECTED_ENVIRONMENT_ADDRESS.equals(ProjectFileUtil.getEnvIP())) {
      throw new AssertionError("The environment address was not injected.");
    }
    String caseId = MM2DataProvider.getClassDataProvider(getClass().getName());
    if (!"CASE/0001 中文?x=1".equals(caseId)) {
      throw new AssertionError("The exact CaseID was not injected.");
    }
  }
}
