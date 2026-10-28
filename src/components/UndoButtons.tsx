import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Redo2, Undo2 } from "lucide-react";
import { useDataMode } from "@/lib/db/mode";
import { localUndo } from "@/lib/db/undo";

const NOT_TYPING = ["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"];
/** In a text box Ctrl+Z undoes the typing, as everywhere else in Windows; the app's undo is for everywhere else. */
function typingIn(target: EventTarget | null) {
  const t = target as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || (t.tagName === "INPUT" && !NOT_TYPING.includes((t as HTMLInputElement).type));
}

/**
 * Undo and redo buttons for the page header, and the keys: Ctrl+Z undoes, Ctrl+Shift+Z or Ctrl+Y redoes.
 * The history is this session's changes to this device's data (src/lib/db/undo.ts).
 */
export function UndoButtons() {
  const qc = useQueryClient();
  const mode = useDataMode();
  useSyncExternalStore(localUndo.subscribe, localUndo.getVersion, () => 0);
  const busy = useRef(false);

  const run = useCallback(async (what: "undo" | "redo") => {
    if (mode !== "local") { toast.info("Undo works on this device's data. Changes made straight to the cloud can't be undone here."); return; }
    if (busy.current) return;
    busy.current = true;
    try {
      const label = await (what === "undo" ? localUndo.undo() : localUndo.redo());
      if (!label) { toast(`Nothing to ${what}`); return; }
      const back = what === "undo" ? "redo" : "undo";
      toast.success(`${what === "undo" ? "Undid" : "Redid"}: ${label}`, { action: { label: back === "undo" ? "Undo" : "Redo", onClick: () => void run(back) } });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      busy.current = false;
      void qc.invalidateQueries();
    }
  }, [mode, qc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || typingIn(e.target) || document.querySelector('[role="dialog"]')) return;
      const k = e.key.toLowerCase();
      const what = k === "z" ? (e.shiftKey ? "redo" : "undo") : k === "y" && !e.shiftKey ? "redo" : null;
      if (!what) return;
      e.preventDefault();
      void run(what);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run]);

  if (mode !== "local") return null;
  const undo = localUndo.nextUndo, redo = localUndo.nextRedo;
  const btn = "rounded-lg p-1.5 text-muted-foreground ring-1 ring-border hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground";
  return (
    <div className="flex items-center gap-1">
      <button type="button" onClick={() => void run("undo")} disabled={!undo} className={btn} aria-label="Undo" title={undo ? `Undo: ${undo} (Ctrl+Z)` : "Nothing to undo"}>
        <Undo2 className="h-4 w-4" />
      </button>
      <button type="button" onClick={() => void run("redo")} disabled={!redo} className={btn} aria-label="Redo" title={redo ? `Redo: ${redo} (Ctrl+Shift+Z or Ctrl+Y)` : "Nothing to redo"}>
        <Redo2 className="h-4 w-4" />
      </button>
    </div>
  );
}
