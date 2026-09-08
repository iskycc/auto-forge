package com.autoforge.adapters.cotest;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import fixture.VersionedClass;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.List;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;
import javax.tools.JavaCompiler;
import javax.tools.ToolProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class IsolatedJarClassLoaderTest {
  @TempDir Path temporaryDirectory;

  @Test
  void loadsApplicationClassesChildFirstButKeepsJdkClassesParentFirst() throws Exception {
    Path jar = compileFixtureJar("VersionedClass", "child");

    try (IsolatedJarClassLoader loader =
        new IsolatedJarClassLoader(
            Collections.singletonList(jar.toUri().toURL()), getClass().getClassLoader())) {
      Class<?> loaded = Class.forName("fixture.VersionedClass", true, loader);

      assertNotSame(VersionedClass.class, loaded);
      assertEquals("child", loaded.getMethod("value").invoke(loaded.getConstructor().newInstance()));
      assertSame(String.class, loader.loadClass("java.lang.String"));
      assertTrue(loaded.getClassLoader() instanceof IsolatedJarClassLoader);
    }
  }

  @Test
  void usesTheCompleteBundleWithoutRestoringRemovedClassesFromImportedJars() throws Exception {
    Path directory = Files.createDirectories(temporaryDirectory.resolve("test-jars"));
    Path imported = Files.createDirectories(temporaryDirectory.resolve("inputs"));
    Files.copy(compileFixtureJar("VersionedClass", "old"), imported.resolve("tests.jar"));
    Files.copy(compileFixtureJar("RemovedClass", "removed"), imported.resolve("removed.jar"));
    Path updated = directory.resolve("updated.jar");
    Files.copy(compileFixtureJar("VersionedClass", "updated"), updated);
    try (IsolatedJarClassLoader loader =
        new IsolatedJarClassLoader(
            new JarDirectoryScanner().scan(directory), getClass().getClassLoader())) {
      Class<?> loaded = Class.forName("fixture.VersionedClass", true, loader);
      assertEquals(
          "updated", loaded.getMethod("value").invoke(loaded.getConstructor().newInstance()));
      assertEquals(
          updated.toUri().toURL(), loaded.getProtectionDomain().getCodeSource().getLocation());
      assertThrows(ClassNotFoundException.class, () -> loader.loadClass("fixture.RemovedClass"));
    }
  }

  private Path compileFixtureJar(String className, String value) throws IOException {
    Path source = temporaryDirectory.resolve(value + "/source/fixture/" + className + ".java");
    Path classes = temporaryDirectory.resolve(value + "/classes");
    Files.createDirectories(source.getParent());
    Files.createDirectories(classes);
    Utf8TestIO.write(
        source,
        "package fixture; public final class " + className + " { "
            + "public String value() { return \""
            + value
            + "\"; } }");

    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    int result =
        compiler.run(
            null,
            null,
            null,
            "-source",
            "8",
            "-target",
            "8",
            "-d",
            classes.toString(),
            source.toString());
    assertEquals(0, result);

    Path classFile = classes.resolve("fixture/" + className + ".class");
    Path jar = temporaryDirectory.resolve(value + ".jar");
    try (OutputStream file = Files.newOutputStream(jar);
        JarOutputStream archive = new JarOutputStream(file)) {
      archive.putNextEntry(new JarEntry("fixture/" + className + ".class"));
      Files.copy(classFile, archive);
      archive.closeEntry();
    }
    return jar;
  }
}
