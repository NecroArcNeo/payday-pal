import { decryptBackup, encryptBackup, isEncryptedBackup, WrongPasswordError } from "./backup-crypto";
import { downloadFile } from "./db/backups";
import { validateSnapshot, type Snapshot } from "./db/snapshot";
import { askPassword } from "./password-prompt";

// Backup files that leave the app. They hold everything, private fields included, so saving one asks for
// a password by default; opening one asks for its password if it has one.

/** Asks for a password and downloads the backup. False if the user cancelled. */
export async function saveBackupFile(snapshot: Snapshot, name: string): Promise<boolean> {
  const choice = await askPassword({
    mode: "set",
    title: "Protect this backup file",
    detail: "The file holds all your payroll data, including private details like ID numbers. With a password, nobody can open it without that password, including you: if you forget it, the file can't be opened. Store the password somewhere safe.",
  });
  if (!choice) return false;
  const text = JSON.stringify(snapshot, null, 1);
  if ("plain" in choice) downloadFile(text, name);
  else downloadFile(JSON.stringify(await encryptBackup(text, choice.password)), name.replace(/\.json$/, "-protected.json"));
  return true;
}

/** Reads a backup file, asking for its password if it has one. Null if the user cancelled. Throws if it isn't a valid backup. */
export async function readBackupFile(file: File): Promise<Snapshot | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    throw new Error("Not a valid payroll backup: the file isn't JSON.");
  }
  if (!isEncryptedBackup(raw)) return validateSnapshot(raw);
  let error: string | undefined;
  for (;;) {
    const choice = await askPassword({ mode: "enter", title: `Password for ${file.name}`, detail: "This backup file is password-protected.", ...(error ? { error } : {}) });
    if (!choice || "plain" in choice) return null;
    try {
      return validateSnapshot(JSON.parse(await decryptBackup(raw, choice.password)));
    } catch (e) {
      if (!(e instanceof WrongPasswordError)) throw e;
      error = e.message;
    }
  }
}
