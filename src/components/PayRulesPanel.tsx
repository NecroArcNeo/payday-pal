import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { btnPrimary, inputCls } from "@/components/AppShell";
import { db } from "@/lib/db/mode";
import { usePayrollSettings } from "@/lib/payroll";

/** Settings → Pay rules: when hours become overtime and what overtime pays (payroll_settings, so it syncs). */
export function PayRulesPanel() {
  const qc = useQueryClient();
  const { data: settings } = usePayrollSettings();
  const [threshold, setThreshold] = useState("");
  const [mult, setMult] = useState("");
  const [weekend, setWeekend] = useState(true);
  useEffect(() => {
    if (!settings) return;
    setThreshold(String(settings.ot_threshold));
    setMult(String(settings.ot_multiplier));
    setWeekend(settings.weekend_overtime);
  }, [settings]);
  if (!settings) return null;
  const dirty = Number(threshold) !== settings.ot_threshold || Number(mult) !== settings.ot_multiplier || weekend !== settings.weekend_overtime;

  const save = async () => {
    const t = Number(threshold), m = Number(mult);
    if (threshold.trim() === "" || !Number.isFinite(t) || t < 0 || t > 168) { toast.error("Overtime threshold must be 0–168 hours"); return; }
    if (mult.trim() === "" || !Number.isFinite(m) || m < 1 || m > 5) { toast.error("Overtime multiplier must be between 1 and 5"); return; }
    const { error } = await db().saveSettings({ ot_threshold: t, ot_multiplier: m, weekend_overtime: weekend });
    if (error) { toast.error(error.message); return; }
    toast.success("Pay rules saved");
    void qc.invalidateQueries({ queryKey: ["payroll-settings"] });
  };

  return (
    <div className="glass-panel space-y-4 p-5">
      <div>
        <div className="font-display font-extrabold tracking-tight">Overtime</div>
        <p className="text-xs text-muted-foreground">Days locked as paid keep the pay they were locked with; these rules apply to every other day.</p>
      </div>
      <div className="flex flex-wrap gap-4">
        <label><span className="label-mono">Weekday overtime after (hrs / week)</span>
          <input type="number" step="0.5" className={`${inputCls} mt-1 max-w-[10rem]`} value={threshold} onChange={(e) => setThreshold(e.target.value)} /></label>
        <label><span className="label-mono">Overtime rate (× hourly)</span>
          <input type="number" step="0.1" className={`${inputCls} mt-1 max-w-[10rem]`} value={mult} onChange={(e) => setMult(e.target.value)} /></label>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={weekend} onChange={(e) => setWeekend(e.target.checked)} />
          Saturday and Sunday hours are always overtime
        </label>
      </div>
      <button onClick={save} disabled={!dirty} className={btnPrimary}>Save pay rules</button>
    </div>
  );
}
