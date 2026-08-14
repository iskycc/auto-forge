package com.autoforge.adapters.cotest;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.io.IOException;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class JarDirectoryScannerTest {
  @TempDir Path temporaryDirectory;

  @Test
  void discoversNestedJarFilesInDeterministicOrder() throws IOException {
    Path nested = Files.createDirectories(temporaryDirectory.resolve("nested"));
    Files.write(temporaryDirectory.resolve("z.jar"), new byte[] {1});
    Files.write(temporaryDirectory.resolve("autoforge-case.jar"), new byte[] {4});
    Files.write(nested.resolve("a.JAR"), new byte[] {2});
    Files.write(nested.resolve("ignored.txt"), new byte[] {3});

    List<URL> urls = new JarDirectoryScanner().scan(temporaryDirectory);

    assertEquals(3, urls.size());
    assertEquals(temporaryDirectory.resolve("autoforge-case.jar").toUri().toURL(), urls.get(0));
    assertEquals(nested.resolve("a.JAR").toUri().toURL(), urls.get(1));
    assertEquals(temporaryDirectory.resolve("z.jar").toUri().toURL(), urls.get(2));
  }

  @Test
  void rejectsAnEmptyJarDirectory() {
    assertThrows(
        IllegalArgumentException.class,
        () -> new JarDirectoryScanner().scan(temporaryDirectory));
  }

  @Test
  void scansAllJarsWithinThreeDirectoriesAndIgnoresDeeperFiles() throws IOException {
    Path thirdLevel =
        Files.createDirectories(temporaryDirectory.resolve("one").resolve("two").resolve("three"));
    Path accepted = thirdLevel.resolve("accepted.jar");
    Files.write(accepted, new byte[] {1});
    Path fourthLevel = Files.createDirectories(thirdLevel.resolve("four"));
    Files.write(fourthLevel.resolve("ignored.jar"), new byte[] {2});

    List<URL> urls = new JarDirectoryScanner().scan(temporaryDirectory);

    assertEquals(List.of(accepted.toUri().toURL()), urls);
  }
}
