import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "数芽｜双模型讲题评测",
  description: "小学数学 AI 讲题双模型对话评测平台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
