import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

const EVENT = "meridian-theme";

/** Switches light/night mode and remembers it. The header button and Ctrl+K both use it; the event keeps the button's icon in step. */
export function toggleTheme() {
  const next = !document.documentElement.classList.contains("dark");
  document.documentElement.classList.toggle("dark", next);
  localStorage.setItem("theme", next ? "dark" : "light");
  window.dispatchEvent(new Event(EVENT));
}

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const read = () => setDark(document.documentElement.classList.contains("dark"));
    read();
    window.addEventListener(EVENT, read);
    return () => window.removeEventListener(EVENT, read);
  }, []);

  return (
    <button
      onClick={toggleTheme}
      aria-label={dark ? "Switch to light mode" : "Switch to night mode"}
      className="grid h-9 w-9 place-items-center rounded-xl bg-secondary text-muted-foreground ring-1 ring-border hover:text-foreground"
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
