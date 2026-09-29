package com.autoforge.adapters.cotest;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import cotest.auto.dataproviders.MM2DataProvider;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import org.junit.jupiter.api.Test;

class CotestRuntimeConfigurerTest {
  private static final String API_URL = "http://platform:3100/api/v1/public/ddt/projects/p/versions/v/stages/s/case";

  @Test
  void configuresTheApiForOrdinaryCasesWithoutSettingACaseId() throws Exception {
    try (PrintStream output = AdapterMain.utf8PrintStream(new ByteArrayOutputStream())) {
      new CotestRuntimeConfigurer(output).configure(getClass().getClassLoader(), getClass(), "", null, API_URL);
      assertEquals(API_URL, MM2DataProvider.getDdtInsightUrl());
    }
  }

  @Test
  void missingProviderIsOptionalForOrdinaryCasesButRequiredForDdt() throws Exception {
    ClassLoader missingProvider = new ClassLoader(getClass().getClassLoader()) {
      @Override public Class<?> loadClass(String name) throws ClassNotFoundException {
        if (name.equals("cotest.auto.dataproviders.MM2DataProvider")) throw new ClassNotFoundException(name);
        return super.loadClass(name);
      }
    };
    try (PrintStream output = AdapterMain.utf8PrintStream(new ByteArrayOutputStream())) {
      CotestRuntimeConfigurer configurer = new CotestRuntimeConfigurer(output);
      assertDoesNotThrow(() -> configurer.configure(missingProvider, getClass(), "", null, API_URL));
      assertThrows(ClassNotFoundException.class, () -> configurer.configure(missingProvider, getClass(), "", "CASE-1", API_URL));
    }
  }

  @Test
  void doesNotRequireCotestUtilityClassesWhenNoCotestValuesAreConfigured() throws Exception {
    try (PrintStream output = AdapterMain.utf8PrintStream(new ByteArrayOutputStream())) {
      CotestRuntimeConfigurer configurer = new CotestRuntimeConfigurer(output);
      assertDoesNotThrow(
          () -> configurer.configure(getClass().getClassLoader(), getClass(), "", null, null));
    }
  }
}
