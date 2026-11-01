// Email reset of the desktop app's password, through the cloud account (opt-in; cloud migration 0016).
// The account keeps one escrow key per computer, filed under that computer's keyring id. It only opens the
// computer's own keyring.json (electron/keyring.mjs), so the cloud alone can't read any payroll data.
import { supabase } from "@/integrations/supabase/client";

const fail = (error: { message: string } | null) => {
  if (error) throw new Error(error.message);
};

export async function uploadEscrow(keyringId: string, escrowKey: string, deviceName: string) {
  const { error } = await supabase.rpc("set_key_escrow" as never, { p_keyring_id: keyringId, p_escrow_key: escrowKey, p_device_name: deviceName } as never);
  fail(error);
}

export async function deleteEscrow(keyringId: string) {
  const { error } = await supabase.rpc("delete_key_escrow" as never, { p_keyring_id: keyringId } as never);
  fail(error);
}

/** Emails a one-time sign-in code (never makes a new account). A code, not a link: a link can't open the desktop app. */
export async function sendResetCode(email: string) {
  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  fail(error);
}

/** Signs in with the emailed code, then fetches this computer's escrow key. */
export async function escrowWithCode(email: string, code: string, keyringId: string): Promise<string> {
  const { error } = await supabase.auth.verifyOtp({ email, token: code.trim(), type: "email" });
  fail(error);
  const { data, error: rpcError } = await supabase.rpc("get_key_escrow" as never, { p_keyring_id: keyringId } as never);
  fail(rpcError);
  if (!data) throw new Error("This account has no email reset for this computer. Use the recovery key instead.");
  return data as string;
}
