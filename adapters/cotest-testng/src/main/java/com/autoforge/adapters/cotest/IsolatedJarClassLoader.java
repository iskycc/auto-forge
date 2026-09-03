package com.autoforge.adapters.cotest;

import java.net.URL;
import java.net.URLClassLoader;
import java.util.Arrays;
import java.util.List;

final class IsolatedJarClassLoader extends URLClassLoader {
  private static final List<String> PARENT_FIRST_PREFIXES =
      Arrays.asList(
          "java.",
          "javax.",
          "jdk.",
          "sun.",
          "com.sun.",
          "org.w3c.dom.",
          "org.xml.sax.",
          "com.autoforge.adapters.cotest.");

  static {
    registerAsParallelCapable();
  }

  IsolatedJarClassLoader(List<URL> jarUrls, ClassLoader parent) {
    super(jarUrls.toArray(new URL[0]), parent);
  }

  @Override
  protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
    synchronized (getClassLoadingLock(name)) {
      Class<?> loaded = findLoadedClass(name);
      if (loaded == null) {
        loaded = parentFirst(name) ? loadFromParent(name) : loadFromJarsThenParent(name);
      }
      if (resolve) {
        resolveClass(loaded);
      }
      return loaded;
    }
  }

  private Class<?> loadFromJarsThenParent(String name) throws ClassNotFoundException {
    try {
      return findClass(name);
    } catch (ClassNotFoundException missingFromJars) {
      return loadFromParent(name);
    }
  }

  private Class<?> loadFromParent(String name) throws ClassNotFoundException {
    return super.loadClass(name, false);
  }

  private static boolean parentFirst(String className) {
    for (String prefix : PARENT_FIRST_PREFIXES) {
      if (className.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }
}
