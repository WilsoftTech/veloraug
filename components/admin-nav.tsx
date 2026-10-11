import { NavLink } from "@/components/nav-link";

const SECTIONS = [
  { href: "/admin", label: "Overview", exact: true },
  { href: "/admin/discovery", label: "Review queue" },
  { href: "/admin/catalogue", label: "Catalogue" },
];

/** Section tabs shared by every admin page (the same underline tabs as TabLinks, driven by the path). */
export function AdminNav() {
  return (
    <nav aria-label="Admin sections" className="border-b border-border">
      <ul className="flex gap-6 overflow-x-auto pb-px">
        {SECTIONS.map((section) => (
          <li key={section.href}>
            <NavLink
              href={section.href}
              exact={section.exact}
              className="-mb-px inline-flex min-h-11 min-w-11 items-center justify-center whitespace-nowrap border-b-2 px-1 text-label-lg transition-colors"
              activeClassName="border-highlight text-foreground"
              inactiveClassName="border-transparent text-muted hover:text-foreground"
            >
              {section.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
