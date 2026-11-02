import { describe, expect, it } from "vitest";
import { formatMoney } from "@/lib/utils";

describe("formatMoney", () => {
  it("formats integer minor units without floating point input", () => {
    expect(formatMoney(40000, "USD")).toBe("$400.00");
  });
});
