package cotest.auto.dataproviders;

import java.util.HashMap;
import java.util.Map;

public final class MM2DataProvider {
  private static final Map<String, String> CLASS_DATA_FILES = new HashMap<>();

  private MM2DataProvider() {}

  public static void setClassDataProvider(String className, String file) {
    CLASS_DATA_FILES.put(className, file);
  }

  public static String getClassDataProvider(String className) {
    return CLASS_DATA_FILES.get(className);
  }
}
