import http from "node:http";
import { config } from "./config.js";
import { allContacts } from "./contacts.js";
import { finishConnect } from "./google.js";
import type { Outbox } from "./types.js";

// Friday's only public pages: what Google's sign-in needs. A home page, the privacy policy, and the address Google
// sends people back to. It listens on localhost; nginx on the server adds HTTPS in front of it.

const SUPPORT_EMAIL = "onestopautopartsindonesia@gmail.com";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="id">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { max-width: 680px; margin: 0 auto; padding: 32px 16px; font: 16px/1.6 system-ui, sans-serif; }
  h1 { font-size: 1.6rem; line-height: 1.25; }
  h2 { font-size: 1.1rem; margin-top: 2rem; }
</style>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>`;
}

function homePage(): string {
  const bot = escapeHtml(config.BOT_NAME);
  return page(
    bot,
    `<p>${bot} adalah asisten AI pribadi di WhatsApp untuk keluarga dan teman. ${bot} membantu menjawab pertanyaan, membuat pengingat, dan menyusun dokumen.</p>
<p>Pengguna yang sudah mendapat akses bisa menghubungkan akun Google miliknya sendiri, agar ${bot} bisa membantu dengan Calendar, Tasks, Gmail, Drive, Docs, Sheets, Slides, Forms, Contacts, dan YouTube.</p>
<p><a href="/privacy">Kebijakan privasi</a></p>`,
  );
}

function privacyPage(): string {
  const bot = escapeHtml(config.BOT_NAME);
  const admin = escapeHtml(allContacts()[0]?.name ?? "pengelola");
  return page(
    `Kebijakan privasi ${bot}`,
    `<p>Berlaku sejak 1 November 2026. ${bot} adalah layanan pribadi yang dikelola ${admin} untuk keluarga dan teman.</p>

<h2>Data Google yang diakses</h2>
<p>Hanya kalau kamu menghubungkan akun Google lewat /google dan menyetujui izinnya, ${bot} bisa mengakses data berikut saat kamu memintanya di chat pribadi:</p>
<ul>
  <li>Calendar: membaca dan mengubah acara.</li>
  <li>Tasks: membaca dan mengubah tugas.</li>
  <li>Gmail: membaca email, membuat draf, dan mengirim email.</li>
  <li>Drive: mencari dan membaca file, dan menyimpan file baru.</li>
  <li>Docs, Sheets, Slides, Forms: membuat dan mengubah file, dan membaca jawaban formulir.</li>
  <li>Contacts: mencari kontak.</li>
  <li>YouTube: mencari video dan melihat langganan.</li>
  <li>Alamat email akun Google, untuk menunjukkan akun mana yang terhubung.</li>
</ul>

<h2>Data Hevy yang diakses</h2>
<p>Hanya kalau kamu menghubungkan akun Hevy lewat /hevy dengan API key milikmu, ${bot} bisa membaca dan mencatat workout, rutinitas, latihan, dan ukuran tubuh (seperti berat badan) di akun Hevy itu, saat kamu memintanya di chat pribadi. Yang kamu minta langsung disimpan, dan kamu selalu dapat ringkasan apa yang tersimpan. ${bot} tidak memakai akun Hevy-mu di grup.</p>
<p>Kalau kamu menerima ajakan workout bareng, selama sesi itu sesama anggota bisa mencatat dan melihat set yang dicatat untukmu, begitu juga anggota grup WhatsApp tempat sesi dimulai, seperti yang disebut di ajakannya. ${bot} memakai daftar latihan di Hevy-mu untuk mencocokkan nama latihan. Saat sesi selesai, catatan itu disimpan ke Hevy-mu dan kamu dapat ringkasannya.</p>

<h2>Cara data dipakai</h2>
<p>Data dipakai hanya untuk menjalankan permintaanmu. Setiap perubahan, seperti mengirim email atau mengubah acara, baru dijalankan setelah kamu mengonfirmasinya dengan kode. ${bot} tidak bekerja di grup untuk data Google.</p>
<p>${bot} tidak menjual data, tidak memakainya untuk iklan atau penilaian kredit, dan tidak memakainya untuk melatih model AI umum.</p>

<h2>Pihak lain</h2>
<p>Dengan persetujuanmu, isi yang dibaca ${bot} dikirim ke Anthropic (Claude) untuk diproses, karena fitur ini tidak bisa berjalan tanpa itu. Balasan dan pesanmu terkirim lewat WhatsApp. Data tidak dibagikan ke pihak lain, kecuali diwajibkan hukum.</p>

<h2>Penyimpanan dan keamanan</h2>
<p>Token akses Google dan API key Hevy disimpan terenkripsi di server ${bot}, dan koneksi memakai HTTPS. API key Hevy tidak pernah dikirim ke Anthropic. Isi yang dibaca ${bot} tersimpan di riwayat chat di server yang sama, dan bisa ikut masuk ke cadangan harian.</p>
<p>${admin} mengelola server itu, jadi secara teknis punya jalur ke data tersebut. ${admin} tidak membaca data Google pengguna, kecuali kamu memintanya, atau diperlukan untuk keamanan, perbaikan penyalahgunaan, atau kewajiban hukum.</p>

<h2>Memutus akses dan menghapus data</h2>
<p>Kirim /google putus ke ${bot} untuk mencabut akses, menghapus token, dan menghapus riwayat chat pribadimu di server. Kamu juga bisa mencabut akses di <a href="https://myaccount.google.com/permissions">pengaturan akun Google</a>. Kirim /hevy putus untuk menghapus API key Hevy dan riwayat chat pribadimu di server; buat ulang API key di pengaturan Hevy kalau mau key lama tidak berlaku. Salinan di cadangan terhapus saat cadangan lama dibersihkan.</p>

<h2>Kebijakan Google</h2>
<p>Penggunaan dan pemindahan informasi yang diterima dari Google API mengikuti <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, termasuk ketentuan Limited Use.</p>

<h2>Kontak</h2>
<p>Pertanyaan soal privasi: tanya langsung ke ${admin}, atau kirim email ke ${SUPPORT_EMAIL}.</p>`,
  );
}

export async function handleWeb(method: string, url: string, outbox: Outbox): Promise<{ status: number; html: string }> {
  const { pathname, searchParams } = new URL(url, "http://localhost");
  if (method !== "GET" && method !== "HEAD") return { status: 405, html: page("Tidak didukung", "") };
  if (pathname === "/") return { status: 200, html: homePage() };
  if (pathname === "/privacy") return { status: 200, html: privacyPage() };
  if (pathname === "/oauth/google/callback") {
    const result = await finishConnect(searchParams.get("state") ?? "", searchParams.get("code") ?? undefined, outbox);
    return { status: result.ok ? 200 : 400, html: page(result.title, `<p>${escapeHtml(result.text)}</p>`) };
  }
  return { status: 404, html: page("Halaman tidak ditemukan", "") };
}

export function startWeb(outbox: Outbox): http.Server {
  const server = http.createServer((req, res) => {
    void handleWeb(req.method ?? "GET", req.url ?? "/", outbox)
      .catch((err) => {
        console.error("Web request failed:", err instanceof Error ? err.message : "unknown error");
        return { status: 500, html: page("Terjadi kesalahan", "<p>Coba lagi sebentar lagi.</p>") };
      })
      .then(({ status, html }) => {
        res.writeHead(status, {
          "Content-Type": "text/html; charset=utf-8",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
        });
        res.end(req.method === "HEAD" ? undefined : html);
      });
  });
  server.listen(config.WEB_PORT, "127.0.0.1", () => console.log(`Web pages on 127.0.0.1:${config.WEB_PORT}`));
  server.unref();
  return server;
}
