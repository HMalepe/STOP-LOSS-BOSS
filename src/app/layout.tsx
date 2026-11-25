import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ServiceWorker } from "@/ui/ServiceWorker";
import "./globals.css";

export const metadata: Metadata = {
  title: "Order Desk",
  description: "Fire and manage many MT5 orders at once.",
  appleWebApp: { capable: true, title: "Order Desk", statusBarStyle: "black-translucent" },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "32x32" },
      { url: "/icons/icon-192.png", type: "image/png", sizes: "192x192" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0d11",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        {children}
        <ServiceWorker enabled={process.env.NODE_ENV === "production"} />
      </body>
    </html>
  );
}
