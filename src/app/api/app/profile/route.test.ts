import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "./route";
import * as operatorCsrfModule from "@/lib/security/operator-csrf";

const mockGetUser = vi.fn();
const mockUpdateUser = vi.fn();
const mockUpsert = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: mockGetUser,
      updateUser: mockUpdateUser,
    },
    from: vi.fn((table: string) => {
      if (table === "profiles") {
        return { upsert: mockUpsert };
      }
      throw new Error(`Unexpected table ${table}`);
    }),
  })),
}));

vi.mock("@/lib/security/operator-csrf", () => ({
  validateOperatorCsrf: vi.fn(),
}));

describe("PATCH /api/app/profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(operatorCsrfModule.validateOperatorCsrf).mockResolvedValue({ valid: true });
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-123", email: "sam@example.com" } },
      error: null,
    });
    mockUpsert.mockResolvedValue({ error: null });
    mockUpdateUser.mockResolvedValue({ error: null });
  });

  it("rejects missing or invalid operator CSRF tokens with 403", async () => {
    vi.mocked(operatorCsrfModule.validateOperatorCsrf).mockResolvedValue({
      valid: false,
      error: "MISSING_HEADER",
    });

    const res = await PATCH(
      new Request("https://payroost.com/api/app/profile", {
        method: "PATCH",
        body: JSON.stringify({ displayName: "Sam", countryCode: "US" }),
      }),
    );

    expect(res.status).toBe(403);
  });

  it("returns 401 when user is unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error("Unauthorized") });

    const res = await PATCH(
      new Request("https://payroost.com/api/app/profile", {
        method: "PATCH",
        body: JSON.stringify({ displayName: "Sam", countryCode: "US" }),
      }),
    );

    expect(res.status).toBe(401);
  });

  it("validates countryCode ISO format and saves profile cleanly", async () => {
    const badRes = await PATCH(
      new Request("https://payroost.com/api/app/profile", {
        method: "PATCH",
        body: JSON.stringify({ displayName: "Sam Studio", countryCode: "USA" }),
      }),
    );
    expect(badRes.status).toBe(400);

    const okRes = await PATCH(
      new Request("https://payroost.com/api/app/profile", {
        method: "PATCH",
        body: JSON.stringify({ displayName: "Sam Studio", countryCode: "us" }),
      }),
    );
    expect(okRes.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith(
      {
        id: "user-123",
        display_name: "Sam Studio",
        country_code: "US",
      },
      { onConflict: "id" },
    );
  });
});
