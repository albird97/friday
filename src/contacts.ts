import { config, type Contact } from "./config.js";
import { db } from "./db.js";
import { localDay } from "./time.js";

/** Contacts from ALLOWED_CONTACTS plus those the admin added over WhatsApp. */
export function allContacts(): Contact[] {
  const added = db.prepare("SELECT name, number FROM contacts ORDER BY added_at").all() as Contact[];
  const seen = new Set(config.contacts.map((c) => c.number));
  return [...config.contacts, ...added.filter((c) => !seen.has(c.number))];
}

export function contactByNumber(number: string): Contact | undefined {
  return allContacts().find((c) => c.number === number);
}

/** Look a contact up by name (case-insensitive) or phone number. */
export function findContact(nameOrNumber: string): Contact | undefined {
  const query = nameOrNumber.trim().toLowerCase();
  const digits = query.replace(/\D/g, "");
  return allContacts().find(
    (c) => c.name.toLowerCase() === query || (digits.length >= 8 && c.number === digits),
  );
}

export function isAdmin(number: string): boolean {
  return config.contacts[0]?.number === number;
}

export function addContact(name: string, number: string): Contact {
  const digits = number.replace(/\D/g, "");
  if (digits.length < 8) throw new Error(`"${number}" doesn't look like a phone number (use country code, e.g. 6281234567890).`);
  db.prepare("INSERT OR REPLACE INTO contacts (number, name, added_at) VALUES (?, ?, ?)").run(digits, name.trim(), Date.now());
  return { name: name.trim(), number: digits };
}

/** Removes a contact added over WhatsApp. Contacts from .env must be removed there. */
export function removeContact(nameOrNumber: string): { removed?: Contact; error?: string } {
  const contact = findContact(nameOrNumber);
  if (!contact) return { error: `No contact called "${nameOrNumber}".` };
  if (config.contacts.some((c) => c.number === contact.number)) {
    return { error: `${contact.name} is set in ALLOWED_CONTACTS in .env; remove them there and restart.` };
  }
  db.prepare("DELETE FROM contacts WHERE number = ?").run(contact.number);
  return { removed: contact };
}

/** Counts one message against today's limit. Returns false once the person is over it. */
export function takeDailyQuota(number: string, today = localDay()): boolean {
  if (config.DAILY_MESSAGE_LIMIT === 0 || isAdmin(number)) return true;
  const row = db
    .prepare(
      `INSERT INTO usage (number, day, count) VALUES (?, ?, 1)
       ON CONFLICT (number, day) DO UPDATE SET count = count + 1 RETURNING count`,
    )
    .get(number, today) as { count: number };
  return row.count <= config.DAILY_MESSAGE_LIMIT;
}
