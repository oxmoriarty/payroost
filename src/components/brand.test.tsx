import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Brand, PublicBrandHeader } from "@/components/brand";

afterEach(() => {
  cleanup();
});

describe("PayRoost Brand Assets & Scaling", () => {
  it("stores cropped SVG logo and favicon assets in public/brand and src/app/icon.svg", () => {
    const root = process.cwd();
    expect(existsSync(resolve(root, "public/brand/PayRoostLogo.svg"))).toBe(true);
    expect(existsSync(resolve(root, "public/brand/PayRoostLogo-dark.svg"))).toBe(true);
    expect(existsSync(resolve(root, "public/brand/PayRoostFavicon.svg"))).toBe(true);
    expect(existsSync(resolve(root, "src/app/icon.svg"))).toBe(true);
    expect(existsSync(resolve(root, "PayRoostLogo.svg"))).toBe(false);
    expect(existsSync(resolve(root, "PayRoostFavicon.svg"))).toBe(false);
  });

  it("renders light and dark PayRoostLogo variants with proportional scaling", () => {
    const { rerender } = render(<Brand />);
    const lightImg = screen.getByAltText("Payroost");
    expect(lightImg.getAttribute("src")).toContain("/brand/PayRoostLogo.svg");
    expect(lightImg.className).toContain("h-7");

    rerender(<Brand dark size="lg" />);
    const darkImg = screen.getByAltText("Payroost");
    expect(darkImg.getAttribute("src")).toContain("/brand/PayRoostLogo-dark.svg");
    expect(darkImg.className).toContain("h-8");

    rerender(<Brand compact />);
    const compactImg = screen.getByAltText("Payroost");
    expect(compactImg.className).toContain("h-6");
  });

  it("renders PublicBrandHeader with home link and optional subtitle", () => {
    render(<PublicBrandHeader subtitle="Verified Client Portal" />);
    expect(screen.getByRole("link", { name: "Payroost" })).toHaveAttribute("href", "/");
    expect(screen.getByText("Verified Client Portal")).toBeInTheDocument();
  });
});
