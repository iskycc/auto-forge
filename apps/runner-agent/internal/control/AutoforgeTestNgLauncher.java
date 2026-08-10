import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.testng.IMethodSelector;
import org.testng.IMethodSelectorContext;
import org.testng.ITestNGMethod;
import org.testng.TestNG;
import org.testng.xml.XmlClass;
import org.testng.xml.XmlSuite;
import org.testng.xml.XmlTest;

final class AutoforgeTestNgLauncher {
  private static final String METHOD_SELECTORS_PROPERTY = "autoforge.testng.methodSelectors";

  private AutoforgeTestNgLauncher() {}

  public static void main(String[] arguments) throws Exception {
    LaunchArguments launch = LaunchArguments.parse(arguments);
    Class<?> testClass = Class.forName(launch.className());
    Set<String> available = new HashSet<>();
    for (Method method : testClass.getMethods()) {
      available.add(selector(method));
    }
    if (!available.containsAll(launch.methodSelectors())) {
      Set<String> missing = new HashSet<>(launch.methodSelectors());
      missing.removeAll(available);
      throw new IllegalArgumentException("Selected JVM methods do not exist: " + missing);
    }

    TestNG testng = new TestNG();
    testng.setOutputDirectory(launch.outputDirectory());
    XmlSuite suite = new XmlSuite();
    suite.setName("AutoForge suite");
    XmlTest test = new XmlTest(suite);
    test.setName("AutoForge test");
    test.setXmlClasses(List.of(new XmlClass(testClass)));
    test.setParameters(launch.parameters());
    testng.setXmlSuites(List.of(suite));
    if (!launch.methodSelectors().isEmpty()) {
      System.setProperty(METHOD_SELECTORS_PROPERTY, String.join("\n", launch.methodSelectors()));
      testng.addMethodSelector(ExactMethodSelector.class.getName(), 1_000);
    }
    testng.run();
    System.exit(testng.getStatus());
  }

  private static String selector(Method method) {
    StringBuilder descriptor = new StringBuilder(method.getName()).append('(');
    for (Class<?> parameterType : method.getParameterTypes()) {
      descriptor.append(typeDescriptor(parameterType));
    }
    return descriptor.append(')').append(typeDescriptor(method.getReturnType())).toString();
  }

  private static String typeDescriptor(Class<?> type) {
    if (type.isArray()) return type.getName().replace('.', '/');
    if (!type.isPrimitive()) return "L" + type.getName().replace('.', '/') + ";";
    if (type == void.class) return "V";
    if (type == boolean.class) return "Z";
    if (type == byte.class) return "B";
    if (type == char.class) return "C";
    if (type == short.class) return "S";
    if (type == int.class) return "I";
    if (type == long.class) return "J";
    if (type == float.class) return "F";
    if (type == double.class) return "D";
    throw new IllegalArgumentException("Unsupported JVM type: " + type);
  }

  private record LaunchArguments(
      String className,
      String outputDirectory,
      Set<String> methodSelectors,
      Map<String, String> parameters) {
    static LaunchArguments parse(String[] arguments) {
      String className = null;
      String outputDirectory = null;
      Set<String> methodSelectors = new HashSet<>();
      Map<String, String> parameters = new HashMap<>();
      for (int index = 0; index < arguments.length; index += 2) {
        if (index + 1 >= arguments.length) {
          throw new IllegalArgumentException("Launcher arguments must be option/value pairs.");
        }
        switch (arguments[index]) {
          case "--class" -> className = requireSingle(className, arguments[index + 1], "class");
          case "--output" ->
              outputDirectory = requireSingle(outputDirectory, arguments[index + 1], "output");
          case "--method" -> {
            if (!methodSelectors.add(arguments[index + 1])) {
              throw new IllegalArgumentException("Duplicate method selector.");
            }
          }
          case "--parameter" -> addParameter(parameters, arguments[index + 1]);
          default -> throw new IllegalArgumentException("Unsupported launcher option.");
        }
      }
      if (className == null || className.isBlank() || outputDirectory == null) {
        throw new IllegalArgumentException("Class and output directory are required.");
      }
      return new LaunchArguments(
          className,
          outputDirectory,
          Set.copyOf(methodSelectors),
          Map.copyOf(parameters));
    }

    private static String requireSingle(String current, String value, String name) {
      if (current != null || value.isBlank()) {
        throw new IllegalArgumentException("Invalid " + name + " option.");
      }
      return value;
    }

    private static void addParameter(Map<String, String> parameters, String encoded) {
      int separator = encoded.indexOf('=');
      if (separator < 1 || parameters.putIfAbsent(
              encoded.substring(0, separator), encoded.substring(separator + 1)) != null) {
        throw new IllegalArgumentException("Invalid or duplicate TestNG parameter.");
      }
    }
  }

  public static final class ExactMethodSelector implements IMethodSelector {
    private final Set<String> selectedMethods;

    public ExactMethodSelector() {
      String configured = System.getProperty(METHOD_SELECTORS_PROPERTY, "");
      this.selectedMethods = configured.isEmpty() ? Set.of() : Set.of(configured.split("\n"));
    }

    @Override
    public boolean includeMethod(
        IMethodSelectorContext context, ITestNGMethod testngMethod, boolean isTestMethod) {
      if (!isTestMethod) return true;
      Method method = testngMethod.getConstructorOrMethod().getMethod();
      return method != null && selectedMethods.contains(selector(method));
    }

    @Override
    public void setTestMethods(List<ITestNGMethod> testMethods) {}

  }
}
