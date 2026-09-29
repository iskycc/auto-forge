package cotest.auto.dataproviders;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** Minimal CoTest-compatible data-provider registry used by the real Runner acceptance fixture. */
public final class MM2DataProvider {
  private static final Map<String, String> CLASS_DATA_FILES = new ConcurrentHashMap<>();
  private static String ddtInsightUrl;

  public static void setDdtInsightUrl(String value) {
    ddtInsightUrl = value;
  }

  public static String getDdtInsightUrl() {
    return ddtInsightUrl;
  }

  private MM2DataProvider() {}

  public static void setClassDataProvider(String className, String caseId) {
    CLASS_DATA_FILES.put(className, caseId);
  }

  public static String getClassDataProvider(String className) {
    return CLASS_DATA_FILES.get(className);
  }
}
