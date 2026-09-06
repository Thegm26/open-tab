import type { Metadata } from "next";
import "@fontsource-variable/manrope";
import "./globals.css";

export const metadata: Metadata = {
  title: "Open Tab",
  description: "Shared round-up pool control panel.",
  icons: {
    icon: "/open-tab-symbol.png",
    apple: "/open-tab-symbol.png",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
