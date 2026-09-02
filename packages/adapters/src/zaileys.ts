/**
 * WhatsApp JID <-> E.164 phone normalization for zaileys-backed adapters.
 *
 * WhatsApp identifies users as JIDs (`<phone>[:<device>]@s.whatsapp.net`),
 * groups as `<id>@g.us`, broadcasts as `<id>@broadcast`, and newsletters as
 * `<id>@newsletter`. The rest of the stack stores phones as standard E.164
 * (`+<country><number>`), so these helpers bridge the two representations.
 */

const USER_JID_SUFFIX = "@s.whatsapp.net";
const NON_USER_SUFFIXES = ["@g.us", "@broadcast", "@newsletter"] as const;

const PHONE_DIGITS = /^\d+$/;

/**
 * Convert a WhatsApp user JID into an E.164 phone string.
 *
 * Accepts both bare user JIDs (`<digits>@s.whatsapp.net`) and device-suffixed
 * JIDs (`<digits>:<device>@s.whatsapp.net`). Returns `null` for any non-user
 * JID (`@g.us`, `@broadcast`, `@newsletter`) or malformed input.
 */
export function jidToPhoneE164(jid: string): string | null {
  if (typeof jid !== "string" || jid.length === 0) return null;

  const atIndex = jid.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === jid.length - 1) return null;

  const suffix = jid.slice(atIndex);
  if (suffix !== USER_JID_SUFFIX) return null;

  const local = jid.slice(0, atIndex);
  const colonIndex = local.indexOf(":");
  const phone = colonIndex === -1 ? local : local.slice(0, colonIndex);

  if (phone.length === 0 || !PHONE_DIGITS.test(phone)) return null;

  return `+${phone}`;
}

/**
 * Convert an E.164 phone (or any phone-shaped string) into a WhatsApp user JID.
 *
 * Non-digit characters (`+`, spaces, dashes, parentheses) are stripped before
 * the JID is assembled. Empty or all-non-digit input is treated as a no-op and
 * still returns an empty user JID (`@s.whatsapp.net`) so callers always see a
 * well-formed suffix; callers that need stricter validation should pre-check
 * the digits.
 */
export function phoneE164ToJid(phone: string): string {
  if (typeof phone !== "string") return `${USER_JID_SUFFIX.slice(1)}${USER_JID_SUFFIX}`;
  const digits = phone.replace(/\D/g, "");
  return `${digits}${USER_JID_SUFFIX}`;
}

// Internal: re-export the suffix set so tests can iterate without duplicating literals.
export const _NON_USER_JID_SUFFIXES = NON_USER_SUFFIXES;