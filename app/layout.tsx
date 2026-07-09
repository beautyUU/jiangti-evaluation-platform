import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "讲题评测平台",
  description: "小学数学 AI 讲题双模型对话评测平台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
