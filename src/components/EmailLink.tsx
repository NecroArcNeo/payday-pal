import { Mail, TriangleAlert } from "lucide-react";
import { isEmail, mailto } from "@/lib/email";

/** An email shown as a link that opens the user's mail app; an invalid one stays plain text with a warning. */
export function EmailLink({ email, className = "" }: { email: string; className?: string }) {
  if (isEmail(email)) {
    return <a href={mailto(email)} className={`text-primary underline-offset-2 hover:underline print:text-foreground ${className}`} title={`Email ${email.trim()}`}>{email.trim()}</a>;
  }
  return (
    <span className={className} title="Not a valid email address">
      {email}
      <TriangleAlert className="ml-1 inline h-3.5 w-3.5 align-[-2px] text-amber-500 print:hidden" aria-label="Not a valid email address" />
    </span>
  );
}

/** Beside an email input: opens a new message once the typed address is valid. */
export function EmailButton({ email }: { email: string }) {
  if (!email.trim()) return null;
  return isEmail(email) ? (
    <a href={mailto(email)} className="inline-flex items-center gap-1 text-xs text-primary hover:underline" title={`Email ${email.trim()}`}>
      <Mail className="h-3.5 w-3.5" />Email
    </a>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"><TriangleAlert className="h-3.5 w-3.5" />Not a valid address</span>
  );
}
