// The desktop app's bridge (electron/preload.cjs). Undefined in a normal browser.

type QueryResult<T> = { rows: T[]; affectedRows?: number };

export interface DesktopBridge {
  db: {
    query<T = Record<string, unknown>>(sql: string, params?: unknown[], txId?: number): Promise<QueryResult<T>>;
    exec(sql: string, txId?: number): Promise<null>;
    begin(): Promise<number>;
    end(txId: number, commit: boolean): Promise<null>;
  };
  backups: {
    add(record: object): Promise<number>;
    get<T>(id: number): Promise<T | undefined>;
    list<T>(): Promise<T[]>;
    remove(ids: number[]): Promise<null>;
  };
  /** Where the database folder and the backup files are. */
  info(): Promise<{ dataDir: string; backupDir: string }>;
  openFolder(which: "data" | "backups"): Promise<null>;
  /** Runs `beforeClose` when the window is about to close; the window waits for it (up to 30 s). Replaces any earlier one. */
  onClosing(beforeClose: () => Promise<unknown>): void;
}

export const desktop: DesktopBridge | undefined =
  typeof window === "undefined" ? undefined : (window as unknown as { meridianDesktop?: DesktopBridge }).meridianDesktop;
