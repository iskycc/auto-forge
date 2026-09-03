package com.autoforge.adapters.cotest;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

final class Utf8TestIO {
  private Utf8TestIO() {}

  static String decode(ByteArrayOutputStream output) {
    return new String(output.toByteArray(), StandardCharsets.UTF_8);
  }

  static void write(Path path, String content) throws IOException {
    Files.write(path, content.getBytes(StandardCharsets.UTF_8));
  }

  static void copy(InputStream input, OutputStream output) throws IOException {
    byte[] buffer = new byte[8_192];
    int bytesRead;
    while ((bytesRead = input.read(buffer)) != -1) {
      output.write(buffer, 0, bytesRead);
    }
  }
}
