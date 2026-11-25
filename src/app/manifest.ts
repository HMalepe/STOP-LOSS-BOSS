import type { MetadataRoute } from "next";

/** Installable PWA (07-UI-SPEC): standalone, dark, real icons (maskable for Android). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Order Desk",
    short_name: "Order Desk",
    description: "Fire and manage many MT5 orders at once.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0a0d11",
    theme_color: "#0a0d11",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
