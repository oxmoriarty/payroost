import "server-only";

export class AppUrlConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppUrlConfigurationError";
  }
}

/**
 * Resolves and strictly validates the canonical server application base URL.
 *
 * Rules:
 * 1. Production requires a configured canonical application URL via PAYROOST_APP_URL
 *    (or NEXT_PUBLIC_APP_URL if established by convention).
 * 2. Production must use HTTPS.
 * 3. Localhost and loopback addresses (127.0.0.1, ::1, 0.0.0.0, *.localhost) are rejected in production.
 * 4. Credentials (username/password), query strings, and hash fragments are strictly rejected.
 * 5. Malformed URLs are rejected.
 * 6. Non-production (development, test) falls back to "http://localhost:3000" if unconfigured.
 * 7. Trailing slashes are normalized safely.
 */
export function getCanonicalAppUrl(env: NodeJS.ProcessEnv = process.env): string {
  const isProduction = env.NODE_ENV === "production";
  const rawUrl = (env.PAYROOST_APP_URL || env.NEXT_PUBLIC_APP_URL || "").trim();

  if (!rawUrl) {
    if (isProduction) {
      throw new AppUrlConfigurationError(
        "Production requires a configured canonical application URL (PAYROOST_APP_URL)"
      );
    }
    return "http://localhost:3000";
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AppUrlConfigurationError("Application URL is malformed");
  }

  // Reject credentials (username / password)
  if (parsed.username || parsed.password) {
    throw new AppUrlConfigurationError("Application URL must not contain credentials");
  }

  // Reject query strings
  if (parsed.search || parsed.searchParams.toString().length > 0) {
    throw new AppUrlConfigurationError("Application URL must not contain query parameters");
  }

  // Reject hash fragments
  if (parsed.hash) {
    throw new AppUrlConfigurationError("Application URL must not contain hash fragments");
  }

  if (isProduction) {
    if (parsed.protocol !== "https:") {
      throw new AppUrlConfigurationError("Production application URL must use HTTPS");
    }

    const host = parsed.hostname.toLowerCase();
    const isLocalhostOrLoopback =
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "127.0.0.1" ||
      host.startsWith("127.") ||
      host === "0.0.0.0" ||
      host === "[::1]" ||
      host === "::1";

    if (isLocalhostOrLoopback) {
      throw new AppUrlConfigurationError(
        "Production application URL must not use localhost or loopback addresses"
      );
    }
  }

  // Normalize by stripping trailing slashes
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${pathname}`;
}
