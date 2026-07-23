import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "CloudBoard",
    template: "%s · CloudBoard",
  },
  description:
    "AWS Reserved Instances와 Savings Plans 커버리지를 확인하는 비용 최적화 대시보드",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
