// Which on-device backups to keep. Recent ones are all kept; older ones thin out
// to one per day, then per week, then per month, so a mistake noticed months
// later can still be undone without the backups growing without limit.

const DAY = 24 * 60 * 60 * 1000;
/** Every backup younger than this is kept. */
export const KEEP_ALL_FOR = 2 * DAY;
/** Then the newest backup of each day, up to this age. */
export const DAILY_FOR = 30 * DAY;
/** Then the newest of each week (Monday to Sunday), up to this age; after that, the newest of each month. */
export const WEEKLY_FOR = 365 * DAY;

type Backup = { id: number; created_at: string; reason: string };

const pad = (n: number) => String(n).padStart(2, "0");
const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monday = (d: Date) => day(new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)));

/** The ids to delete. Manual backups, and any with an unreadable date, are never deleted. */
export function backupsToDrop(backups: Backup[], now = Date.now()): number[] {
  const seen = new Set<string>();
  const drop: number[] = [];
  const newestFirst = [...backups].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  for (const b of newestFirst) {
    if (b.reason === "manual") continue;
    const at = Date.parse(b.created_at);
    const age = now - at;
    if (!(age >= KEEP_ALL_FOR)) continue;
    const d = new Date(at);
    const bucket = age < DAILY_FOR ? `day ${day(d)}` : age < WEEKLY_FOR ? `week ${monday(d)}` : `month ${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    if (seen.has(bucket)) drop.push(b.id);
    else seen.add(bucket);
  }
  return drop;
}
