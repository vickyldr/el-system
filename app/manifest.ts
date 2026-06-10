import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "el · 小家",
    short_name: "el",
    description: "el 的小家",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#FDF6EC",
    theme_color: "#C2410C",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
