// How the database orders a page of time records (store.ts `recordOrder`): by date, employee or hours. Any other
// column of the Time records list is sorted in the app (table-sort.ts, record-columns.ts).

export type StoreSortKey = "date" | "employee" | "hours";
/** `desc`: biggest / newest / Z first. */
export type Sort<K extends string = string> = { by: K; desc: boolean };
