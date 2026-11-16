import { useState } from "react";

/** A per-browser preference; falls back to the default when storage is unavailable. */
export function useStoredFlag(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? fallback : stored === "true";
    } catch {
      return fallback;
    }
  });
  const update = (next: boolean) => {
    setValue(next);
    try {
      localStorage.setItem(key, String(next));
    } catch {
      // Only a convenience.
    }
  };
  return [value, update];
}

/** Like useStoredFlag, for an optional string; null removes it. */
export function useStoredString(key: string): [string | null, (value: string | null) => void] {
  const [value, setValue] = useState<string | null>(() => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  });
  const update = (next: string | null) => {
    setValue(next);
    try {
      if (next === null) localStorage.removeItem(key);
      else localStorage.setItem(key, next);
    } catch {
      // Only a convenience.
    }
  };
  return [value, update];
}

/** Collapsed project folders, remembered per browser by project key. */
export function useCollapsedProjects(): [Set<string>, (key: string) => void] {
  const STORAGE_KEY = "collapsed-projects";
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
      return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : []);
    } catch {
      return new Set();
    }
  });
  const toggle = (key: string) => {
    const next = new Set(collapsed);
    if (!next.delete(key)) next.add(key);
    setCollapsed(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      // Only a convenience.
    }
  };
  return [collapsed, toggle];
}
