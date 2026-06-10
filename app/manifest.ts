import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "El",
    short_name: "El",
    description: "El · 小家",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#1a1e2e",
    theme_color: "#1a1e2e",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
