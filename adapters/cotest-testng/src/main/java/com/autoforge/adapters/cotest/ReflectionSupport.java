package com.autoforge.adapters.cotest;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

final class ReflectionSupport {
  private ReflectionSupport() {}

  static Object invoke(Method method, Object target, Object... arguments)
      throws ReflectiveOperationException {
    try {
      return method.invoke(target, arguments);
    } catch (InvocationTargetException invocationFailure) {
      Throwable cause = invocationFailure.getCause();
      if (cause instanceof ReflectiveOperationException) {
        throw (ReflectiveOperationException) cause;
      }
      if (cause instanceof RuntimeException) {
        throw (RuntimeException) cause;
      }
      if (cause instanceof Error) {
        throw (Error) cause;
      }
      throw new AdapterInvocationException("Adapter target method failed.", cause);
    }
  }

  static Throwable rootCause(Throwable failure) {
    Throwable current = failure;
    while (current.getCause() != null && current.getCause() != current) {
      current = current.getCause();
    }
    return current;
  }

  private static final class AdapterInvocationException extends ReflectiveOperationException {
    private static final long serialVersionUID = 1L;

    AdapterInvocationException(String message, Throwable cause) {
      super(message, cause);
    }
  }
}
