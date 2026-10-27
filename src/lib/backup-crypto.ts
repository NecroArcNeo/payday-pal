// Password protection for backup files that leave the app (downloads). AES-256-GCM, with the key derived
// from the password by PBKDF2-SHA-256. GCM also detects a wrong password or a changed file. There is no
// way to open a file without its password: not for the user, not for anyone.

export const ENCRYPTED_FORMAT = "meridian-payroll-backup-encrypted";
/** OWASP's 2023 recommendation for PBKDF2-SHA-256. Takes well under a second on an old laptop. */
const ITERATIONS = 600_000;
export const MIN_PASSWORD_LENGTH = 8;

export type EncryptedBackup = {
  format: typeof ENCRYPTED_FORMAT;
  version: 1;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-GCM"; iv: string };
  data: string;
};

export class WrongPasswordError extends Error {
  constructor() { super("That password doesn't open this file (or the file was changed)."); }
}

const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function keyFor(password: string, salt: Uint8Array, iterations: number) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptBackup(text: string, password: string): Promise<EncryptedBackup> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFor(password, salt, ITERATIONS);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text)));
  return {
    format: ENCRYPTED_FORMAT,
    version: 1,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt: toBase64(salt) },
    cipher: { name: "AES-GCM", iv: toBase64(iv) },
    data: toBase64(data),
  };
}

export function isEncryptedBackup(raw: unknown): raw is EncryptedBackup {
  return !!raw && typeof raw === "object" && (raw as { format?: unknown }).format === ENCRYPTED_FORMAT;
}

export async function decryptBackup(file: EncryptedBackup, password: string): Promise<string> {
  if (file.version !== 1 || file.kdf?.name !== "PBKDF2" || file.cipher?.name !== "AES-GCM") throw new Error("This backup file was made by a newer version of the app.");
  const key = await keyFor(password, fromBase64(file.kdf.salt), file.kdf.iterations);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(file.cipher.iv) as BufferSource }, key, fromBase64(file.data) as BufferSource);
    return new TextDecoder().decode(plain);
  } catch {
    throw new WrongPasswordError();
  }
}
