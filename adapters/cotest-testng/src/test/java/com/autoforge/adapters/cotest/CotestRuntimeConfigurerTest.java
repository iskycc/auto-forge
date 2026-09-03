package com.autoforge.adapters.cotest;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import org.junit.jupiter.api.Test;

class CotestRuntimeConfigurerTest {
  @Test
  void doesNotRequireCotestUtilityClassesWhenNoCotestValuesAreConfigured() throws Exception {
    try (PrintStream output = AdapterMain.utf8PrintStream(new ByteArrayOutputStream())) {
      CotestRuntimeConfigurer configurer = new CotestRuntimeConfigurer(output);
      assertDoesNotThrow(
          () -> configurer.configure(getClass().getClassLoader(), getClass(), "", null));
    }
  }
}
