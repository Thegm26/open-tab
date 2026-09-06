import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Open Tab",
  description: "A simulated shared round-up pool.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}

