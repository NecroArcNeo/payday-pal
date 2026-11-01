// The desktop app's bridge (electron/preload.cjs). Undefined in a normal browser.

type QueryResult<T> = { rows: T[]; affectedRows?: number };

export type SecurityStatus = {
  /** "error": the key file is missing or damaged, so nothing can open. */
  state: "locked" | "unlocked" | "error";
  error: string | null;
  password: boolean;
  recovery: boolean;
  /** Email reset through the cloud account is on. */
  cloud: boolean;
  /** Identifies this computer's key in the cloud account (for email reset). */
  keyringId: string | null;
  /** No password is set, but Windows couldn't unlock the key (the folder came from another computer or account). */
  deviceFailed: boolean;
  /** False only while an unencrypted database from before couldn't be converted yet. */
  encrypted: boolean;
  /** This start converted the database: say so once. */
  justEncrypted: boolean;
  encryptError: string | null;
};

export interface DesktopBridge {
  db: {
    query<T = Record<string, unknown>>(sql: string, params?: unknown[], txId?: number): Promise<QueryResult<T>>;
    exec(sql: string, txId?: number): Promise<null>;
    begin(): Promise<number>;
    end(txId: number, commit: boolean): Promise<null>;
    /** Closes the database and moves its folder aside (never deleted); the next query starts a new, empty one. Returns the folder it moved to. */
    setAside(): Promise<string | null>;
  };
  backups: {
    add(record: object): Promise<number>;
    get<T>(id: number): Promise<T | undefined>;
    list<T>(): Promise<T[]>;
    remove(ids: number[]): Promise<null>;
  };
  /** The encryption key's lock (electron/keyring.mjs). Database and backup calls are refused while it's locked. */
  security: {
    status(): Promise<SecurityStatus>;
    unlock(password: string): Promise<SecurityStatus>;
    /** Unlocks with the recovery key and sets a new password (null: none from now on). */
    recover(recoveryKey: string, newPassword: string | null): Promise<SecurityStatus>;
    /** The same with the escrow key from the cloud account (email reset). */
    recoverWithCloud(escrowKey: string, newPassword: string | null): Promise<SecurityStatus>;
    /** `current` is needed only when a password is set. The first password also makes the recovery key, returned once. */
    setPassword(current: string | null, next: string): Promise<{ status: SecurityStatus; recoveryKey: string | null }>;
    removePassword(current: string): Promise<SecurityStatus>;
    newRecoveryKey(current: string | null): Promise<{ status: SecurityStatus; recoveryKey: string }>;
    /** Returns the escrow key for the cloud account to keep (under `status.keyringId`). */
    enableCloudReset(current: string | null): Promise<{ status: SecurityStatus; escrowKey: string }>;
    disableCloudReset(): Promise<SecurityStatus>;
    /** Only while locked: moves the database and keyring aside (kept) and starts empty with a new key. */
    startOver(): Promise<SecurityStatus>;
  };
  /** Where the database folder and the backup files are, and the computer's name. */
  info(): Promise<{ dataDir: string; backupDir: string; computerName: string }>;
  /** When the previous session started, if it ended without closing the database (crash, power cut, forced quit). */
  session(): Promise<{ uncleanSince: string | null }>;
  openFolder(which: "data" | "backups"): Promise<null>;
  /** Runs `beforeClose` when the window is about to close; the window waits for it (up to 30 s). Replaces any earlier one. */
  onClosing(beforeClose: () => Promise<unknown>): void;
}

/** The react-query key the lock's status is kept under (the start-up gate and the Security panel share it). */
export const SECURITY_STATUS_KEY = ["security-status"];

export const desktop: DesktopBridge | undefined =
  typeof window === "undefined" ? undefined : (window as unknown as { meridianDesktop?: DesktopBridge }).meridianDesktop;
