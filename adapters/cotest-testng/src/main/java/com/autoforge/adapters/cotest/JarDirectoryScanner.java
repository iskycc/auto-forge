package com.autoforge.adapters.cotest;

import java.io.IOException;
import java.net.URL;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

final class JarDirectoryScanner {
  private static final String PRIMARY_CASE_JAR = "autoforge-case.jar";
  private static final int MAX_DIRECTORY_DEPTH = 3;
  private static final int MAX_WALK_DEPTH = MAX_DIRECTORY_DEPTH + 1;
  private static final int MAX_VISITED_ENTRIES = 100_000;

  List<URL> scan(Path directory) {
    Path root = requireDirectory(directory);
    List<Path> jarFiles = new ArrayList<>();
    int[] visitedEntries = {0};
    try {
      Files.walkFileTree(
          root,
          Collections.emptySet(),
          MAX_WALK_DEPTH,
          new SimpleFileVisitor<Path>() {
            @Override
            public FileVisitResult preVisitDirectory(Path current, BasicFileAttributes attributes)
                throws IOException {
              countEntry(visitedEntries);
              return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attributes)
                throws IOException {
              countEntry(visitedEntries);
              if (attributes.isRegularFile()
                  && file.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".jar")) {
                jarFiles.add(file.toAbsolutePath().normalize());
              }
              return FileVisitResult.CONTINUE;
            }
          });
    } catch (IOException error) {
      throw new IllegalArgumentException("Cannot scan JAR directory: " + root, error);
    }
    if (jarFiles.isEmpty()) {
      throw new IllegalArgumentException("JAR directory does not contain any .jar files: " + root);
    }
    jarFiles.sort(
        Comparator.comparingInt(JarDirectoryScanner::classpathPriority)
            .thenComparing(Path::toString));
    List<URL> urls = new ArrayList<>(jarFiles.size());
    for (Path jarFile : jarFiles) {
      try {
        urls.add(jarFile.toUri().toURL());
      } catch (IOException error) {
        throw new IllegalArgumentException("Cannot convert JAR path to URL: " + jarFile, error);
      }
    }
    return Collections.unmodifiableList(urls);
  }

  private static int classpathPriority(Path path) {
    return path.getFileName().toString().equals(PRIMARY_CASE_JAR) ? 0 : 1;
  }

  private static Path requireDirectory(Path directory) {
    Path normalized = directory.toAbsolutePath().normalize();
    if (!Files.isDirectory(normalized)) {
      throw new IllegalArgumentException("JAR directory does not exist: " + normalized);
    }
    return normalized;
  }

  private static void countEntry(int[] visitedEntries) throws IOException {
    visitedEntries[0]++;
    if (visitedEntries[0] > MAX_VISITED_ENTRIES) {
      throw new IOException(
          "JAR directory contains more than " + MAX_VISITED_ENTRIES + " entries.");
    }
  }
}
