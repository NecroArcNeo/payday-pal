// Emails are typed by hand or imported from spreadsheets, so they're checked before being turned into mailto: links.

/** One address: something@domain.tld, no spaces or characters that would break a mailto: link. */
const EMAIL = /^[^\s@<>()[\]\\,;:"?&#%]+@[^\s@<>()[\]\\,;:"?&#%]+\.[^\s@<>()[\]\\,;:"?&#%.]{2,}$/;

export const isEmail = (v: string | null | undefined): v is string => !!v && EMAIL.test(v.trim());

export const mailto = (email: string) => `mailto:${email.trim()}`;
