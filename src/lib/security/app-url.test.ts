import { describe, expect, it } from "vitest";
import { getCanonicalAppUrl, AppUrlConfigurationError } from "./app-url";

describe("Phase 3B.2.3.1: Canonical Application URL Resolver (app-url.ts)", () => {
  it("production accepts a valid canonical HTTPS URL", () => {
    const url = getCanonicalAppUrl({
      NODE_ENV: "production",
      PAYROOST_APP_URL: "https://payroost.agency",
    });
    expect(url).toBe("https://payroost.agency");
  });

  it("normalizes trailing slashes safely", () => {
    const url1 = getCanonicalAppUrl({
      NODE_ENV: "production",
      PAYROOST_APP_URL: "https://payroost.agency/",
    });
    expect(url1).toBe("https://payroost.agency");

    const url2 = getCanonicalAppUrl({
      NODE_ENV: "production",
      PAYROOST_APP_URL: "https://payroost.agency///",
    });
    expect(url2).toBe("https://payroost.agency");

    const urlSubpath = getCanonicalAppUrl({
      NODE_ENV: "production",
      PAYROOST_APP_URL: "https://payroost.agency/app///",
    });
    expect(urlSubpath).toBe("https://payroost.agency/app");
  });

  it("prefers PAYROOST_APP_URL over NEXT_PUBLIC_APP_URL", () => {
    const url = getCanonicalAppUrl({
      NODE_ENV: "production",
      PAYROOST_APP_URL: "https://primary.payroost.com",
      NEXT_PUBLIC_APP_URL: "https://fallback.payroost.com",
    });
    expect(url).toBe("https://primary.payroost.com");
  });

  it("supports NEXT_PUBLIC_APP_URL if PAYROOST_APP_URL is absent", () => {
    const url = getCanonicalAppUrl({
      NODE_ENV: "production",
      NEXT_PUBLIC_APP_URL: "https://public.payroost.com",
    });
    expect(url).toBe("https://public.payroost.com");
  });

  it("production rejects missing configuration with AppUrlConfigurationError", () => {
    expect(() =>
      getCanonicalAppUrl({
        NODE_ENV: "production",
        PAYROOST_APP_URL: "",
        NEXT_PUBLIC_APP_URL: "",
      })
    ).toThrow(AppUrlConfigurationError);

    expect(() =>
      getCanonicalAppUrl({
        NODE_ENV: "production",
      })
    ).toThrow(/Production requires a configured canonical application URL/);
  });

  it("production rejects plain HTTP protocol", () => {
    expect(() =>
      getCanonicalAppUrl({
        NODE_ENV: "production",
        PAYROOST_APP_URL: "http://payroost.agency",
      })
    ).toThrow(/Production application URL must use HTTPS/);
  });

  it("production rejects localhost and loopback hosts", () => {
    expect(() =>
      getCanonicalAppUrl({
        NODE_ENV: "production",
        PAYROOST_APP_URL: "https://localhost:3000",
      })
    ).toThrow(/localhost or loopback/);

    expect(() =>
      getCanonicalAppUrl({
        NODE_ENV: "production",
        PAYROOST_APP_URL: "https://sub.localhost",
      })
    ).toThrow(/localhost or loopback/);

    expect(() =>
      getCanonicalAppUrl({
        NODE_ENV: "production",
        PAYROOST_APP_URL: "https://127.0.0.1:8080",
      })
    ).toThrow(/localhost or loopback/);

    expect(() =>
      getCanonicalAppUrl({
        NODE_ENV: "production",
        PAYROOST_APP_URL: "https://127.1.2.3:3000",
      })
    ).toThrow(/localhost or loopback/);

    expect(() =>
      getCanonicalAppUrl({
        NODE_ENV: "production",
        PAYROOST_APP_URL: "https://0.0.0.0:3000",
      })
    ).toThrow(/localhost or loopback/);

    expect(() =>
      getCanonicalAppUrl({
        NODE_ENV: "production",
        PAYROOST_APP_URL: "https://[::1]:3000",
      })
    ).toThrow(/localhost or loopback/);
  });

  it("rejects URLs with embedded credentials", () => {
    expect(() =>
      getCanonicalAppUrl({
        NODE_ENV: "production",
        PAYROOST_APP_URL: "https://admin:secret@payroost.agency",
      })
    ).toThrow(/credentials/);

    expect(() =>
      getCanonicalAppUrl({
        NODE_ENV: "development",
        PAYROOST_APP_URL: "http://user:pass@localhost:3000",
      })
    ).toThrow(/credentials/);
  });

  it("rejects URLs with query strings", () => {
    expect(() =>
      getCanonicalAppUrl({
        NODE_ENV: "production",
        PAYROOST_APP_URL: "https://payroost.agency?redirect=https://evil.com",
      })
    ).toThrow(/query parameters/);
  });

  it("rejects URLs with hash fragments", () => {
    expect(() =>
      getCanonicalAppUrl({
        NODE_ENV: "production",
        PAYROOST_APP_URL: "https://payroost.agency#target",
      })
    ).toThrow(/hash fragments/);
  });

  it("rejects malformed URLs", () => {
    expect(() =>
      getCanonicalAppUrl({
        NODE_ENV: "production",
        PAYROOST_APP_URL: "invalid-not-a-url",
      })
    ).toThrow(/malformed/);
  });

  it("development/test retains http://localhost:3000 fallback when unconfigured", () => {
    const url = getCanonicalAppUrl({
      NODE_ENV: "development",
    });
    expect(url).toBe("http://localhost:3000");

    const testUrl = getCanonicalAppUrl({
      NODE_ENV: "test",
    });
    expect(testUrl).toBe("http://localhost:3000");
  });
});
