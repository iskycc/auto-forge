package com.huawei.cotest.util;

public final class ProjectFileUtil {
  private static String environmentAddress = "";

  private ProjectFileUtil() {}

  public static void setEnvIP(String value) {
    environmentAddress = value;
  }

  public static String getEnvIP() {
    return environmentAddress;
  }
}
