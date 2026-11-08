import { saveBackup } from "./backups";
import { localDb } from "./local";
import { exportSnapshot } from "./snapshot";

/** Saves a verified backup of this device's data before a big change. Throws if it can't, so the change never runs unprotected. */
export async function backupBefore(change: "import" | "bulk-edit" | "bulk-delete" | "record-edit" | "record-delete" | "copy-week" | "pay-run-delete" | "holiday-pay" | "fill-weeks") {
  await saveBackup(`before-${change}`, await exportSnapshot(await localDb()));
}
