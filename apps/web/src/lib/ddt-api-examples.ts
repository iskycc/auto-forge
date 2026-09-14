export type DdtApiExampleLanguage = "curl" | "javascript" | "groovy";

export function ddtApiExample(
  language: DdtApiExampleLanguage,
  baseUrl: string,
  caseId: string,
): string {
  const base = JSON.stringify(baseUrl);
  const id = JSON.stringify(caseId.trim());
  if (language === "curl") {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    return `curl --fail-with-body --get --max-time 15 \\\n  ${quote(`${baseUrl}/case`)} \\\n  --data-urlencode ${quote(`caseId=${caseId.trim()}`)}`;
  }
  if (language === "javascript") {
    return `async function getDdtCase(baseUrl, caseId) {
  const url = new URL(baseUrl + "/case");
  url.searchParams.set("caseId", caseId);
  const response = await fetch(url, {
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("DDT HTTP " + response.status);
  return response.json();
}

const caseData = await getDdtCase(${base}, ${id});`;
  }
  // JSON string literals are valid Groovy literals once GString interpolation is escaped.
  const groovyLiteral = (value: string) => JSON.stringify(value).replaceAll("$", "\\$");
  return `import groovy.json.JsonSlurper
import java.net.HttpURLConnection
import java.net.URLEncoder

Map getDdtCase(String baseUrl, String caseId) {
    String query = URLEncoder.encode(caseId, "UTF-8")
    HttpURLConnection connection = (HttpURLConnection) new URL(baseUrl + "/case?caseId=" + query).openConnection()
    connection.connectTimeout = 5000
    connection.readTimeout = 15000
    connection.useCaches = false
    try {
        int status = connection.responseCode
        if (status == 404) return null
        if (status != 200) throw new IOException("DDT HTTP " + status)
        return connection.inputStream.withCloseable { stream ->
            (Map) new JsonSlurper().parse(stream, "UTF-8")
        }
    } finally {
        connection.disconnect()
    }
}

Map caseData = getDdtCase(${groovyLiteral(baseUrl)}, ${groovyLiteral(caseId.trim())})`;
}
