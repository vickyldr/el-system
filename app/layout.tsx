import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { Fraunces } from "next/font/google";
import "./globals.css";
import RegisterSW from "./register-sw";

// 温润复古的衬线体——只给拉丁字母/英文/数字用（中文仍走 PingFang），轻量、有灵魂。
const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-fraunces",
  display: "swap",
});

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
    <html lang="zh-CN" className={fraunces.variable}>
      <body>
        {children}
        <RegisterSW />
      </body>
    </html>
  );
}
