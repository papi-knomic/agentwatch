import { useEffect, useState } from "react";

export const SETTINGS_TABS = [
  { id: "agents", label: "Agents" },
  { id: "notifications", label: "Notifications" },
  { id: "phone", label: "Phone" },
  { id: "answering", label: "Answering" },
  { id: "general", label: "General" },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

export type Route = { page: "dashboard" } | { page: "settings"; tab: SettingsTab };

const DEFAULT_TAB: SettingsTab = "agents";

/**
 * `#/settings/<tab>` opens Settings. Anything else (including the pairing link `#pair=<code>`, which has no
 * leading slash) is the dashboard, so the two uses of the hash can't clash.
 */
export function parseRoute(hash: string): Route {
  const match = /^#\/settings(?:\/([a-z-]*))?\/?$/.exec(hash);
  if (!match) return { page: "dashboard" };
  const tab = SETTINGS_TABS.find((t) => t.id === match[1]);
  return { page: "settings", tab: tab?.id ?? DEFAULT_TAB };
}

export function settingsHref(tab: SettingsTab = DEFAULT_TAB): string {
  return `#/settings/${tab}`;
}

export function useRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return parseRoute(hash);
}
