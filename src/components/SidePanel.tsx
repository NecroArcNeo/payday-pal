import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ResizeHandle, useDragSize } from "@/components/ResizeHandle";

// A panel fixed to the right of the window, beside the page rather than over it (non-modal: the page stays usable),
// with a left edge that can be dragged to make it wider. Time records opens a record in one (RecordPanel), Employees an
// employee's profile (EmployeePanel). Its width is remembered per panel (`id`).
//
// Through a portal into <body>: the pages' panels have a backdrop blur, and an ancestor with a filter or transform
// becomes the box `position: fixed` is measured from, so the panel would be stuck inside it.
//
// While it's open, <html> gets `side-panel-open` and `--side-panel-w`, which styles.css uses to narrow the page on wide
// screens (so no column hides behind the panel) and to move toasts clear of its buttons.

const MIN = 320;
/** The page keeps at least this much room beside the panel. */
const PAGE_MIN = 480;

export function SidePanel({ id, defaultWidth = 432, labelledBy, children }: {
  id: string; defaultWidth?: number; labelledBy: string; children: React.ReactNode;
}) {
  const [room, setRoom] = useState(() => (typeof window === "undefined" ? 1600 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setRoom(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const { size, save, reset, clamp } = useDragSize(`meridian-panel-width:${id}`, defaultWidth, MIN, room - PAGE_MIN);
  const panel = useRef<HTMLElement>(null);

  // While dragging, the width is set directly on the panel and the page's padding (no re-render per pointer move).
  const follow = (w: number) => {
    if (panel.current) panel.current.style.width = `min(${w}px, 100vw)`;
    document.documentElement.style.setProperty("--side-panel-w", `${w}px`);
  };
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add("side-panel-open");
    html.style.setProperty("--side-panel-w", `${size}px`);
  }, [size]);
  useEffect(() => () => {
    document.documentElement.classList.remove("side-panel-open");
    document.documentElement.style.removeProperty("--side-panel-w");
  }, []);

  return createPortal(
    <aside ref={panel} role="dialog" aria-modal="false" aria-labelledby={labelledBy} style={{ width: `min(${size}px, 100vw)` }}
      className="@container fixed inset-y-0 right-0 z-40 flex flex-col border-l border-border bg-background shadow-2xl duration-200 animate-in slide-in-from-right">
      {/* On a narrow window the panel fills it, so there's nothing to drag. */}
      <div className="hidden sm:block">
        <ResizeHandle edge="left" size={size} clamp={clamp} onSize={follow} onDone={save} onReset={reset} label="Panel width" />
      </div>
      {children}
    </aside>,
    document.body,
  );
}
