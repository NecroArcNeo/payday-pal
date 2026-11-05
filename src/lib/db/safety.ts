import { saveBackup } from "./backups";
import { localDb } from "./local";
import { getDataMode } from "./mode";
import { exportSnapshot } from "./snapshot";
import { supabaseCloud } from "./sync";

/**
 * Saves a verified backup of the data a big change is about to touch — this
 * device's data, or a copy of the cloud data when editing the cloud. Throws if
 * it can't, so the change never runs unprotected.
 */
export async function backupBefore(change: "import" | "bulk-edit" | "bulk-delete" | "record-edit" | "record-delete" | "copy-week" | "pay-run-delete") {
  if (getDataMode() === "local") await saveBackup(`before-${change}`, await exportSnapshot(await localDb()));
  else await saveBackup(`before-${change}-cloud-copy`, (await supabaseCloud.pull()).snapshot);
}
