import { config, type Contact } from "./config.js";
import { allContacts } from "./contacts.js";
import { imagesEnabled } from "./images.js";
import { transcriptionEnabled } from "./transcribe.js";
import type { Outbox } from "./types.js";

// What someone gets when the admin adds them with /add. It lists only what any contact can use, so errands and onehub
// stay out. It promises nothing about privacy either: those questions go to the admin, as in the system prompt.

export function welcomeMessage(name: string): string {
  const bot = config.BOT_NAME;
  const admin = allContacts()[0]?.name ?? "admin";
  const feature = (title: string, example: string) => `${title}\n${example}`;
  return [
    `Halo ${name}! 👋`,
    `Saya *${bot}*, asisten AI di WhatsApp. ${admin} baru saja memberi kamu akses, jadi sekarang kamu bisa langsung chat di sini seperti chat dengan teman.`,
    "*Yang bisa saya bantu:*",
    feature("💬 *Tanya apa saja*", `"Ide menu makan malam untuk 4 orang dong"`),
    feature("🔎 *Cari info terbaru di internet*", `"Harga emas hari ini berapa?"`),
    feature("⏰ *Pengingat, sekali atau berulang*", `"Ingatkan aku minum obat tiap hari jam 8 pagi"`),
    feature("📷 *Baca foto dan file*", `Kirim foto atau PDF, lalu tulis "Ringkas isi surat ini"`),
    ...(transcriptionEnabled ? [feature("🎙️ *Mengerti voice note*", "Kirim voice note, nanti saya balas dengan teks")] : []),
    feature("📄 *Buat PDF, Word, Excel, dan PowerPoint*", `"Buatkan anggaran belanja bulanan dalam Excel"`),
    ...(imagesEnabled ? [feature("🎨 *Buat dan edit gambar*", `"Buatkan gambar ucapan ulang tahun bertema kucing"`)] : []),
    feature("🧠 *Mengingat hal penting*", `"Ingat ya, aku alergi udang"`),
    feature(`📨 *Titip pesan ke ${admin}*`, `"Bilang ke ${admin} aku telat 15 menit"`),
    feature("📊 *Bantu di grup, termasuk membuat polling*", `Kalau saya ada di grupmu, mention saya atau awali dengan "${bot}," lalu tulis "buat polling tanggal makan bareng"`),
    [
      "*Tips:*",
      "- Boleh pakai bahasa apa saja, saya balas dengan bahasa yang sama",
      "- /reset untuk mulai obrolan baru, /help untuk melihat bantuan",
      ...(config.DAILY_MESSAGE_LIMIT > 0 ? [`- Batasnya ${config.DAILY_MESSAGE_LIMIT} pesan per hari`] : []),
      "- Saya bisa salah, jadi cek lagi untuk hal yang penting",
    ].join("\n"),
    `Ada pertanyaan soal ${bot}, termasuk soal privasi? Tanya langsung ke ${admin} ya.`,
  ].join("\n\n");
}

/** Greets someone just added and says how that went, for the admin. A failed greeting never undoes the /add. */
export async function sendWelcome(contact: Contact, outbox: Outbox): Promise<string> {
  if ((await outbox.isOnWhatsApp?.(contact.number)) === false) {
    return `⚠️ Pesan sambutan tidak terkirim: +${contact.number} tidak terdaftar di WhatsApp. Cek lagi nomornya, harus pakai kode negara.`;
  }
  try {
    await outbox.sendText(outbox.chatIdFor(contact.number), welcomeMessage(contact.name));
    return "Pesan sambutan sudah dikirim.";
  } catch (err) {
    return `⚠️ Pesan sambutan gagal dikirim: ${err instanceof Error ? err.message : String(err)}`;
  }
}
