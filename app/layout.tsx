import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import { BottomNav } from "@/components/bottom-nav";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { THEME_STORAGE_KEY } from "@/lib/theme";
import "./globals.css";

// Variable font: one file covers every weight in DESIGN.md's type scale (400–800).
const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  title: {
    default: "Velora UG — Your World of Entertainment",
    template: "%s · Velora UG",
  },
  description: "Velora UG helps you find, save, and explore movies and series that move you.",
  applicationName: "Velora UG",
};

const themeInitializer = `(function(){try{var k=${JSON.stringify(THEME_STORAGE_KEY)},p=localStorage.getItem(k),r=document.documentElement,v=p==="light"||p==="dark"?p:"system";if(v==="system")r.removeAttribute("data-theme");else r.setAttribute("data-theme",v);var d=v==="dark"||(v==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);r.style.colorScheme=d?"dark":"light";var m=document.querySelector('meta[name="theme-color"]');if(m)m.content=d?"#070b14":"#f8f7f4"}catch(e){}})()`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${jakarta.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <meta name="theme-color" content="#070b14" />
        <script dangerouslySetInnerHTML={{ __html: themeInitializer }} />
      </head>
      <body className="flex min-h-full flex-col">
        <a
          href="#main-content"
          className="sr-only rounded-default bg-accent px-4 py-2 text-label-lg text-accent-foreground focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50"
        >
          Skip to content
        </a>
        <SiteHeader />
        <main id="main-content" className="flex-1">
          {children}
        </main>
        <SiteFooter />
        <BottomNav />
      </body>
    </html>
  );
}
