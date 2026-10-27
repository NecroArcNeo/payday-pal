import { useState } from "react";
import { MAX_ALIAS, setAlias, useLabels } from "@/lib/labels";

/**
 * A label the user can give their own name: click it (double-click with `trigger="dblclick"`, for labels inside
 * links), type an alias, press Enter (Escape cancels). An empty alias brings the real name back.
 * Clicks don't reach a surrounding <label>, <th> or link. `data-label-key` lets DataTable key column widths by it.
 */
export function EditableLabel({ k, name, className = "", trigger = "click" }: { k: string; name: string; className?: string; trigger?: "click" | "dblclick" }) {
  const { label, aliasOf } = useLabels();
  const [editing, setEditing] = useState(false);
  const alias = aliasOf(k);
  const stop = (e: React.SyntheticEvent) => { e.preventDefault(); e.stopPropagation(); };
  const how = trigger === "click" ? "Click" : "Double-click";

  if (editing) {
    const done = (v: string | null) => { if (v !== null) setAlias(k, v, name); setEditing(false); };
    return (
      <input autoFocus defaultValue={alias ?? ""} placeholder={name} maxLength={MAX_ALIAS} aria-label={`Name for ${name}`} data-label-key={k}
        title={`Your name for "${name}". Leave empty to show "${name}" again.`}
        className={`${className} min-w-[6rem] rounded bg-background px-1 font-[inherit] normal-case tracking-normal text-foreground outline-none ring-1 ring-primary`}
        onClick={stop} onMouseDown={(e) => e.stopPropagation()} draggable={false} onDragStart={stop}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") { e.preventDefault(); done(e.currentTarget.value); }
          if (e.key === "Escape") { e.preventDefault(); done(null); }
        }}
        onBlur={(e) => done(e.currentTarget.value)} />
    );
  }
  const start = (e: React.SyntheticEvent) => { stop(e); setEditing(true); };
  return (
    <span data-label-key={k} role={trigger === "click" ? "button" : undefined} tabIndex={trigger === "click" ? 0 : undefined}
      className={`${className} ${trigger === "click" ? "cursor-text" : ""} decoration-dotted underline-offset-2 hover:underline print:no-underline`}
      title={alias ? `${alias}: your name for "${name}". ${how} to change; clear it to show "${name}" again.` : `${how} to give "${name}" your own name`}
      onClick={trigger === "click" ? start : undefined}
      onDoubleClick={trigger === "dblclick" ? start : undefined}
      onKeyDown={(e) => { if ((e.key === "Enter" && trigger === "click") || e.key === "F2") start(e); }}>
      {label(k, name)}
    </span>
  );
}
