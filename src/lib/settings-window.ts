import { useSyncExternalStore } from "react";

// Which section of the Settings window is open (null: closed). A module-level store rather than page state or the
// address, so any page, button or Ctrl+K action can open it straight to a section ("Pay rules", "Checks"…), and the
// window (mounted once in AppShell) follows.

export const SETTINGS_SECTIONS = [
  { id: "features", label: "Features" },
  { id: "pay", label: "Pay rules" },
  { id: "checks", label: "Checks & colours" },
  { id: "display", label: "Display" },
  { id: "privacy", label: "Privacy & security" },
  { id: "backups", label: "Backups" },
  { id: "history", label: "Edit history" },
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

let open: SettingsSection | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

export function openSettings(section: SettingsSection = "features") {
  open = section;
  notify();
}

export function closeSettings() {
  open = null;
  notify();
}

/** The open section, or null while the window is closed. */
export function useSettingsWindow(): SettingsSection | null {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => open,
    () => null,
  );
}
