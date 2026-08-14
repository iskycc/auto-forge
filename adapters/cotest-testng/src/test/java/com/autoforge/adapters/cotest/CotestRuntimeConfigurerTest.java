package com.autoforge.adapters.cotest;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

class CotestRuntimeConfigurerTest {
  @Test
  void doesNotRequireCotestUtilityClassesWhenNoCotestValuesAreConfigured() throws Exception {
    try (PrintStream output =
        new PrintStream(new ByteArrayOutputStream(), true, StandardCharsets.UTF_8)) {
      CotestRuntimeConfigurer configurer = new CotestRuntimeConfigurer(output);
      assertDoesNotThrow(
          () -> configurer.configure(getClass().getClassLoader(), getClass(), "", null));
    }
  }
}
