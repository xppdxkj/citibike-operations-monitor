import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const incoming = await headers();
  const host = incoming.get("host") ?? "localhost:3005";
  const origin = `${host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https"}://${host}`;
  const title = "Citi Bike Operations Monitor｜实时运营与调度看板";
  const description = "融合 Citi Bike 实时站点状态、天气特征、库存风险规则与车辆调度复核的运营看板。";
  return {
    metadataBase: new URL(origin),
    title,
    description,
    icons: { icon: "/favicon.svg" },
    openGraph: { title, description, type: "website", images: [{ url: `${origin}/og-citibike-operations.png`, width: 1672, height: 941, alt: "Citi Bike Operations Monitor 实时运营与调度看板" }] },
    twitter: { card: "summary_large_image", title, description, images: [`${origin}/og-citibike-operations.png`] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
