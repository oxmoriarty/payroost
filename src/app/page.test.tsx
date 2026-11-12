import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import LandingPage from "./page";

afterEach(() => {
  cleanup();
});

describe("LandingPage", () => {
  it("renders brand logo, editorial sections, and interactive workflow tabs without hyphens in text", () => {
    const { container } = render(<LandingPage />);

    expect(screen.getAllByAltText("Payroost").length).toBeGreaterThanOrEqual(2);
    expect(
      screen.getByRole("heading", {
        name: "Clear agreements and milestone records for independent work.",
      })
    ).toBeInTheDocument();

    const portalTab = screen.getByRole("tab", { name: /Client portal/i });
    fireEvent.click(portalTab);
    expect(screen.getByText("One calm link for client reviews")).toBeInTheDocument();

    const recordsTab = screen.getByRole("tab", { name: /Payment records/i });
    fireEvent.click(recordsTab);
    expect(screen.getByText("Honest payment history")).toBeInTheDocument();

    const textContent = container.textContent ?? "";
    expect(textContent).not.toMatch(/[-–—]/);
  });
});
