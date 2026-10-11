"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

interface NavLinkProps {
  href: string;
  children: ReactNode;
  className?: string;
  activeClassName?: string;
  /** Classes for the other state, when they would conflict with the active ones. */
  inactiveClassName?: string;
  /** Active on this path only, not on the pages beneath it (a section's index). */
  exact?: boolean;
}

/** The only client piece of the navigation: it just needs the current path. */
export function NavLink({ href, children, className, activeClassName, inactiveClassName, exact }: NavLinkProps) {
  const pathname = usePathname();
  const active = href === "/" || exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(className, active ? activeClassName : inactiveClassName)}
    >
      {children}
    </Link>
  );
}
