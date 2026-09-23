"use client";

import { useLayoutEffect, useRef } from "react";
import { isThemePreference, THEME_STORAGE_KEY, type ThemePreference } from "@/lib/theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function applyTheme(preference: ThemePreference) {
  const root = document.documentElement;
  if (preference === "system") root.removeAttribute("data-theme");
  else root.dataset.theme = preference;

  const dark = preference === "dark" || (preference === "system" && window.matchMedia(DARK_QUERY).matches);
  root.style.colorScheme = dark ? "dark" : "light";
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", dark ? "#070b14" : "#f8f7f4");
}

function storedPreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(value) ? value : "system";
  } catch {
    return "system";
  }
}

export function ThemeControl() {
  const selectRef = useRef<HTMLSelectElement>(null);

  useLayoutEffect(() => {
    const initial = storedPreference();
    if (selectRef.current) selectRef.current.value = initial;
    applyTheme(initial);

    const media = window.matchMedia(DARK_QUERY);
    const onSystemChange = () => {
      if (storedPreference() === "system") applyTheme("system");
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const next = isThemePreference(event.newValue) ? event.newValue : "system";
      if (selectRef.current) selectRef.current.value = next;
      applyTheme(next);
    };

    media.addEventListener("change", onSystemChange);
    window.addEventListener("storage", onStorage);
    return () => {
      media.removeEventListener("change", onSystemChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  function changeTheme(next: ThemePreference) {
    applyTheme(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // The selected theme still applies for this page when storage is unavailable.
    }
  }

  return (
    <label className="flex min-h-11 items-center gap-3 text-body-sm text-muted">
      <span>Appearance</span>
      <select
        ref={selectRef}
        aria-label="Appearance"
        defaultValue="system"
        onChange={(event) => {
          if (isThemePreference(event.target.value)) changeTheme(event.target.value);
        }}
        className="min-h-11 rounded-default border border-border bg-background px-3 text-body-sm text-foreground"
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
