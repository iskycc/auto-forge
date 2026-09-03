package com.autoforge.adapters.cotest;

/** String predicates implemented without relying on APIs added after Java 8. */
final class TextValues {
  private TextValues() {}

  static boolean isBlank(String value) {
    if (value == null || value.isEmpty()) {
      return true;
    }
    for (int index = 0; index < value.length(); index++) {
      if (!Character.isWhitespace(value.charAt(index))) {
        return false;
      }
    }
    return true;
  }
}
