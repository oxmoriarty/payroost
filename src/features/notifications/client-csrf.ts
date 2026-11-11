export async function fetchAppCsrfToken(): Promise<string> {
  const response = await fetch("/api/app/csrf", {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
  });

  if (!response.ok) {
    throw new Error("Unable to initialize security token.");
  }

  const data = (await response.json()) as { csrfToken?: unknown };
  if (typeof data.csrfToken !== "string" || data.csrfToken.length === 0) {
    throw new Error("Security token response was invalid.");
  }

  return data.csrfToken;
}
