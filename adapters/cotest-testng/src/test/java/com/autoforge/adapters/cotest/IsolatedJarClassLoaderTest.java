package com.autoforge.adapters.cotest;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertSame;
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
    Path jar = compileChildVersionJar();

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

  private Path compileChildVersionJar() throws IOException {
    Path source = temporaryDirectory.resolve("source/fixture/VersionedClass.java");
    Path classes = temporaryDirectory.resolve("classes");
    Files.createDirectories(source.getParent());
    Files.createDirectories(classes);
    Utf8TestIO.write(
        source,
        "package fixture; public final class VersionedClass { "
            + "public String value() { return \"child\"; } }");

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

    Path classFile = classes.resolve("fixture/VersionedClass.class");
    Path jar = temporaryDirectory.resolve("child.jar");
    try (OutputStream file = Files.newOutputStream(jar);
        JarOutputStream archive = new JarOutputStream(file)) {
      archive.putNextEntry(new JarEntry("fixture/VersionedClass.class"));
      Files.copy(classFile, archive);
      archive.closeEntry();
    }
    return jar;
  }
}
