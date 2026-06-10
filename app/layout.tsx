import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import RegisterSW from "./register-sw";

export const metadata: Metadata = {
  title: "El",
  description: "El · 小家",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "El",
  },
  icons: {
    icon: "/icon-192.png",
    apple: "/icon-192.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#1a1e2e",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        <RegisterSW />
      </body>
    </html>
  );
}
