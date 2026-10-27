import type { Sql } from "./snapshot";

// _meta holds sync bookkeeping. It has no change trigger, so writing it never counts as a data change.
export async function getMeta(sql: Sql, key: string): Promise<string | null> {
  const { rows } = await sql.query<{ value: string }>("select value from _meta where key = $1", [key]);
  return rows[0]?.value ?? null;
}

export async function setMeta(sql: Sql, key: string, value: string | null) {
  if (value === null) await sql.query("delete from _meta where key = $1", [key]);
  else await sql.query("insert into _meta (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value", [key, value]);
}

export async function changeSeq(sql: Sql): Promise<number> {
  return Number((await getMeta(sql, "change_seq")) ?? 0);
}
