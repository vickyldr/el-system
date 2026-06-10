import type { ReactNode } from "react";

export const metadata = {
  title: "el-system",
  description: "小家 — el 的后端",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
