// A chart on the page as a picture: the chart's SVG (drawn by Recharts) copied with every colour and font written
// into it, drawn on a canvas under a title and the legend (which is HTML, not part of the SVG). Always in the light
// theme on white, so it prints well whichever theme is on screen. Used by ReportChart's "Save picture" / "Save PDF".

/** The SVG properties that come from the stylesheet (Tailwind classes, the chart's CSS variables), not attributes. */
const STYLED = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "opacity", "font-family", "font-size", "font-weight", "text-anchor", "dominant-baseline", "visibility", "display"];
/** Canvas pixels per screen pixel: sharp in print and on high-DPI screens. */
const SCALE = 2;
const PAD = 24;

export type LegendItem = { label: string; cssColor: string };

/**
 * Runs `read` with the light theme's styles in force, then puts the theme back. It's all one synchronous task, so the
 * browser never paints in between: the screen doesn't flicker, but getComputedStyle sees the light colours.
 */
function inLightTheme<T>(read: () => T): T {
  const html = document.documentElement;
  const dark = html.classList.contains("dark");
  if (dark) html.classList.remove("dark");
  try { return read(); } finally { if (dark) html.classList.add("dark"); }
}

/** The chart's SVG as a standalone file: a copy with each element's computed style written onto it. */
function standaloneSvg(svg: SVGSVGElement): { text: string; width: number; height: number } {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  // The copy has the same elements in the same order, so the nth original styles the nth copy.
  const from = [svg, ...svg.querySelectorAll("*")];
  const to = [copy, ...copy.querySelectorAll("*")];
  from.forEach((el, i) => {
    const cs = getComputedStyle(el);
    (to[i] as SVGElement).setAttribute("style", STYLED.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";"));
  });
  const { width, height } = svg.getBoundingClientRect();
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("width", String(width));
  copy.setAttribute("height", String(height));
  return { text: new XMLSerializer().serializeToString(copy), width, height };
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The chart couldn't be drawn as a picture."));
    img.src = src;
  });
}

/**
 * The chart inside `container` as a canvas: title, subtitle, legend, chart. `legend` colours are CSS (e.g.
 * `var(--color-s0)`), resolved here in the light theme.
 */
export async function chartCanvas(container: HTMLElement, title: string, subtitle: string, legend: LegendItem[]): Promise<HTMLCanvasElement> {
  // Recharts draws the plot in its "surface" SVG; legend icons are small SVGs too, so take the biggest.
  const svgs = [...container.querySelectorAll<SVGSVGElement>("svg.recharts-surface")];
  const svg = svgs.sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
  if (!svg) throw new Error("There's no chart to save yet.");

  const { file, colours, fonts } = inLightTheme(() => {
    const probe = document.createElement("span");
    container.appendChild(probe);
    const colours = legend.map((l) => { probe.style.color = l.cssColor; return getComputedStyle(probe).color; });
    probe.remove();
    const body = getComputedStyle(document.body);
    const heading = document.querySelector(".font-display");
    return { file: standaloneSvg(svg), colours, fonts: { body: body.fontFamily, display: heading ? getComputedStyle(heading).fontFamily : body.fontFamily, muted: "#6b7280", text: "#111827" } };
  });
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.text)}`);

  // Lay out the legend first: it wraps onto as many lines as it needs.
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = `13px ${fonts.body}`;
  const width = Math.ceil(file.width) + PAD * 2;
  const items: { x: number; line: number; i: number }[] = [];
  let x = PAD, line = 0;
  legend.forEach((l, i) => {
    const w = 12 + 6 + measure.measureText(l.label).width + 18;
    if (x + w > width - PAD && x > PAD) { x = PAD; line++; }
    items.push({ x, line, i });
    x += w;
  });
  const legendTop = PAD + 26 + (subtitle ? 20 : 0) + 10;
  const chartTop = legendTop + (legend.length ? (line + 1) * 20 + 8 : 0);
  const height = chartTop + Math.ceil(file.height) + PAD;

  const canvas = document.createElement("canvas");
  canvas.width = width * SCALE;
  canvas.height = height * SCALE;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = "top";
  ctx.fillStyle = fonts.text;
  ctx.font = `800 18px ${fonts.display}`;
  ctx.fillText(title, PAD, PAD);
  if (subtitle) {
    ctx.fillStyle = fonts.muted;
    ctx.font = `13px ${fonts.body}`;
    ctx.fillText(subtitle, PAD, PAD + 26);
  }
  ctx.font = `13px ${fonts.body}`;
  for (const it of items) {
    const y = legendTop + it.line * 20;
    ctx.fillStyle = colours[it.i]!;
    ctx.fillRect(it.x, y + 2, 12, 12);
    ctx.fillStyle = fonts.text;
    ctx.fillText(legend[it.i]!.label, it.x + 18, y + 1);
  }
  ctx.drawImage(img, PAD, chartTop, file.width, file.height);
  return canvas;
}

export function canvasPng(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The picture couldn't be made."))), "image/png"));
}
