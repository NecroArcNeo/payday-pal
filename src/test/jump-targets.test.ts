import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Ctrl+K's actions point at features by name (`jump("/records", "copy-week")`, src/components/CommandPalette.tsx);
// each name must be on an element somewhere (`data-find="copy-week"`, or a FoldBox's `id="records:new"`), else the
// action goes to the page and finds nothing. Renaming one without the other fails here.

const SRC = join(__dirname, "..");
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : /\.tsx$/.test(n) ? [p] : [];
});

describe("Ctrl+K jump targets", () => {
  const palette = readFileSync(join(SRC, "components", "CommandPalette.tsx"), "utf8");
  const targets = [...palette.matchAll(/jump\("[^"]+", "([^"]+)"(?:, \{[^}]*box: "([^"]+)")?/g)].flatMap((m) => [m[1]!, ...(m[2] ? [m[2]] : [])]);
  const code = files(SRC).filter((f) => !f.endsWith("CommandPalette.tsx")).map((f) => readFileSync(f, "utf8")).join("\n");

  it("finds the actions' targets", () => {
    expect(targets.length).toBeGreaterThan(15);
  });

  it.each([...new Set(targets)])("%s is on the page", (t) => {
    const marked = code.includes(`data-find="${t}"`) || new RegExp(`<FoldBox[^>]*\\bid="${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(code);
    expect(marked).toBe(true);
  });
});
