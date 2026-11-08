import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { ClipboardPaste } from "lucide-react";
import { btnGhost } from "@/components/AppShell";
import { modalOpen } from "@/lib/choice-prompt";
import { handOffPasted, isRows, readPasted } from "@/lib/import/paste";
import type { Sheet } from "@/lib/import/parse";

// Pasting rows copied from a spreadsheet (or a web page, a PDF, an email…): Ctrl+V anywhere on the page that isn't a
// text box, or the "Paste rows" button. The rows go to the Import page as a sheet (src/lib/import/paste.ts).

/** Calls `onSheet` with rows pasted while no text box, dialog or menu has the focus. */
export function usePasteRows(onSheet: (sheet: Sheet) => void) {
  const latest = useRef(onSheet);
  latest.current = onSheet;
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = e.target as HTMLElement | null;
      // Pasting into a field is just typing; a dialog's paste is its own business.
      // Time records' "Edit in cells" pastes into its own cells ([data-own-paste]).
      if (el?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable=true], [data-own-paste]") || modalOpen()) return;
      const sheet = readPasted(e.clipboardData?.getData("text/plain") ?? "", e.clipboardData?.getData("text/html") ?? "");
      if (!sheet || !isRows(sheet)) return;
      e.preventDefault();
      latest.current(sheet);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);
}

/** What's on the clipboard now, read when a button is pressed (no paste event to read it from). */
async function clipboardSheet(): Promise<Sheet | null> {
  let text = "", html = "";
  try {
    for (const item of await navigator.clipboard.read()) {
      if (item.types.includes("text/html")) html = await (await item.getType("text/html")).text();
      if (item.types.includes("text/plain")) text = await (await item.getType("text/plain")).text();
    }
  } catch {
    text = await navigator.clipboard.readText().catch(() => "");
  }
  return readPasted(text, html);
}

/** "Paste rows": reads the clipboard and passes the rows on; says what to do when there are none. */
export function PasteRowsButton({ onSheet, className = btnGhost }: { onSheet: (sheet: Sheet) => void; className?: string }) {
  const paste = async () => {
    const sheet = await clipboardSheet();
    if (!sheet || !isRows(sheet)) {
      toast.info("Nothing to paste yet", { description: "Copy some rows (in Excel, Google Sheets, a web page…), then press Paste rows or Ctrl+V here." });
      return;
    }
    onSheet(sheet);
  };
  return (
    <button type="button" data-find="paste-rows" onClick={() => void paste()} className={className} title="Add time records from rows copied in Excel, Google Sheets or anywhere else (or press Ctrl+V on this page)">
      <ClipboardPaste className="mr-1 inline h-4 w-4" />Paste rows
    </button>
  );
}

/** Time records' paste: hands the rows to the Import page, which opens on them as hours. */
export function usePasteToImport() {
  const navigate = useNavigate();
  return (sheet: Sheet) => { handOffPasted(sheet); void navigate({ to: "/import" }); };
}
