import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PaymentOperationsGrid } from "@/features/payments/payment-operations-grid";
import { developmentTransactions } from "@/features/payments/seed-transactions";

describe("PaymentOperationsGrid", () => {
  it("renders a labelled read-only transaction table container", () => {
    render(createElement(PaymentOperationsGrid, { rows: developmentTransactions }));
    expect(screen.getByLabelText("Payment Operations transaction table")).toBeInTheDocument();
  });
});
