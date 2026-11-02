import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Payroost | Clearer freelance work",
  description: "A calmer workspace for freelance agreements, milestones, and payment records.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
