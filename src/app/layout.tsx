import type { Metadata, Viewport } from "next";
import { Barlow_Condensed, Inter, JetBrains_Mono } from "next/font/google";
import { headers } from "next/headers";
import { CSPProvider } from "@base-ui/react/csp-provider";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });
const mono = JetBrains_Mono({ variable: "--font-jetbrains-mono", subsets: ["latin"], display: "swap" });
// Display face for the wordmark only.
const barlow = Barlow_Condensed({
  variable: "--font-barlow-condensed",
  subsets: ["latin"],
  weight: ["300", "800"],
  style: ["italic"],
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Litt's Loans", template: "%s · Litt's Loans" },
  description: "Staff system for Litt's Loans: loans, mortgages, collections, commission and the books.",
  robots: { index: false, follow: false },
  applicationName: "Litt's Loans",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FAFAF7" },
    { media: "(prefers-color-scheme: dark)", color: "#131514" },
  ],
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Per-request CSP nonce from src/proxy.ts — next-themes injects an inline script
  // and Base UI injects small <style> elements (e.g. the Select popup).
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html
      lang="en-GB"
      suppressHydrationWarning
      className={`${inter.variable} ${mono.variable} ${barlow.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <CSPProvider nonce={nonce}>
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange nonce={nonce}>
            <TooltipProvider>
              {children}
              <Toaster position="bottom-right" richColors closeButton />
            </TooltipProvider>
          </ThemeProvider>
        </CSPProvider>
      </body>
    </html>
  );
}
