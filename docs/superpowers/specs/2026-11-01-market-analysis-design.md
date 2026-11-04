# Analisis Teknikal Pasar di Friday

Disetujui Albert pada 2026-11-01. Friday menganalisis saham Indonesia dan AS, emas, forex, dan crypto di timeframe apa
pun, lalu mengirim chart yang sudah digambari hasil analisanya, rencana trading, dan peluang profit. Pertanyaan lanjutan
dijawab di percakapan yang sama. Hanya untuk kontak, tidak tampil di website dan katalog (`pending` di feature-map).

## Yang boleh dan tidak boleh diklaim

Diukur pada 32 instrumen, sudah dipotong biaya, tanpa melihat data masa depan:

- Empat aturan TA klasik tidak berbeda nyata dari entry acak di 1D, 4H, 1H, dan 15m. Makin kecil timeframe, makin rugi.
- Rentang harga terkalibrasi tepat: rentang 80% kena 77,6-79,5%, rentang 90% kena 86,8-89,3%.

Karena itu:

- Friday tidak pernah menjanjikan akurasi arah atau profit, dan menyebut dirinya bukan penasihat berlisensi.
- "Peluang profit" adalah frekuensi historis setup yang sama pada instrumen dan timeframe yang sama, setelah biaya.
  Selalu ditampilkan dengan rentang keyakinan, jumlah sampel, hasil rata-rata, dan pembanding entry acak.
- Peluang kena TP dan peluang berakhir profit adalah dua angka berbeda. Trade yang keluar untung saat batas waktu habis
  ikut dihitung profit tapi tidak dihitung kena TP, jadi keduanya selalu ditampilkan terpisah.
- Win rate saja tidak cukup, karena bisa dinaikkan dengan TP kecil dan SL lebar. Hasil rata-rata (R) selalu ikut tampil.
- Status SIAP hanya keluar kalau uji historis menunjukkan keunggulan terukur. Selain itu statusnya TUNGGU dengan dua
  skenario bersyarat, jadi rencana tetap ada tanpa memaksa sinyal.

## Sumber data

Gratis, tanpa API key, dan sudah dites dari server produksi sebagai user `friday`.

| Pasar | Sumber | Catatan |
|---|---|---|
| Saham Indonesia, AS, lainnya | Yahoo v8 chart | `BBCA` jadi `BBCA.JK`, `BRK.B` jadi `BRK-B` |
| Forex | Yahoo v8 chart | `EUR/USD` jadi `EURUSD=X`, volume tidak ada |
| Crypto | Binance spot, lalu futures, lalu Yahoo | Kandidat `BTC` jadi `BTCUSDT` |
| Emas | Binance `XAUUSDT` di bawah 1D, Yahoo `GC=F` untuk 1D ke atas | Yahoo tidak punya `XAUUSD=X` |

- Pakai `fetch` Node apa adanya. Menyamar sebagai browser justru kena 429 dan tidak boleh dipakai.
- Pakai `period1` dan `period2`, karena `range=max` diam-diam menurunkan data ke bulanan.
- Candle yang belum tutup selalu dibuang. Harga terkini dilaporkan terpisah.
- Yahoo tidak resmi: kalau 429, tool memberi pesan jelas dan tidak mencoba mengakali.

## Unit

| File | Tugas |
|---|---|
| `src/market/indicators.ts` | Fungsi murni: EMA, Wilder, RSI, ATR, ADX, MACD, OBV. Nilai di indeks i hanya memakai data sampai i |
| `src/market/candles.ts` | Timeframe, simbol, ambil data, gabung candle, candle tertutup |
| `src/market/analysis.ts` | Struktur, level, rentang, uji historis, status, rencana |
| `src/market/report.ts` | Laporan untuk Claude, termasuk cara menjawab dan pertanyaan lanjutan |
| `src/market/chart.ts` | PNG lewat sharp dari SVG, tanpa dependency baru |
| `src/tools.ts` | Tool `market_analysis`, hanya kontak |
| `src/prompt.ts` | Kapan memakai tool dan cara menjawab pertanyaan lanjutan |

## Mesin analisis

- **Sinyal konfluensi:** enam suara (harga vs EMA50, EMA50 vs EMA200, RSI vs 50, histogram MACD, DI saat ADX >= 20, OBV vs
  rata-ratanya) semua searah, dan baru saja menjadi searah.
- **Breakout:** stop order di swing terdekat atau ekstrem 5 candle terakhir, mana yang lebih dekat, berlaku untuk candle
  berikutnya. Ini skenario saat TUNGGU.
- **Stop:** di luar swing terakhir ditambah 0,25 ATR. Kalau jaraknya di luar 1-3 ATR, pakai 1,5 ATR, dan long tidak pernah
  di bawah separuh harga entry.
- **Target:** 1R, 2R, 3R, tanpa target di bawah nol. Batas waktu 30 candle.
- **Uji historis mengukur level yang tercetak:** rencana dan uji memakai satu fungsi harga (`levelsOf`), termasuk fraksi
  harga. Stop dan target ditetapkan dari entry rencana, lalu terisi di harga sebenarnya. Stop order terisi di level, atau
  di open kalau gap melewatinya. Rencana SIAP terisi di open berikutnya. Gap dihitung sebagai kerugian nyata, candle yang
  menyentuh stop bersama entry atau target dihitung rugi, biaya per pasar dipotong.
- **Per sisi dan per target:** long dan short diulang terpisah, jadi short yang tidak bisa diambil di saham Indonesia
  tidak menghalangi long. Tiap target punya rangkaian trade sendiri, satu posisi sekali jalan.
- **Pembanding acak:** semua candle dicoba sebagai entry di open berikutnya dengan mesin keluar yang sama.
- **Keunggulan terukur:** minimal 30 trade, dan batas bawah hasil rata-rata di target 2R di atas nol dan di atas entry acak.
  Hanya berlaku untuk timeframe harian ke atas, karena di bawah itu sinyalnya rugi setelah biaya (4H -0,06R, 1H -0,16R,
  15m -0,31R). Sinyal hanya hidup di candle tempat ia terbentuk.
- **Bukti gerbang SIAP:** diuji berjalan di 32 instrumen, 115 dari 2236 sinyal harian lolos, dengan +0,26R ±0,28. Itu
  indikasi, bukan bukti, dan angka yang tercetak pada SIAP cenderung terlalu tinggi karena memang terpilih dari yang
  tinggi. Skenario breakout sendiri rata-rata rugi setelah biaya (harian -0,05R ±0,02), dan Friday menampilkannya apa adanya.
- **Angka peluang terkalibrasi:** dihitung hanya dari trade sebelumnya lalu dibandingkan dengan trade berikutnya. TP2
  harian: tercetak kena 29,8%, profit 38,5%, nyata 29,5% dan 38,1% dari 11.267 trade. TP2 1H: tercetak 28,5% dan 35,1%,
  nyata 28,6% dan 35,6% dari 26.294 trade.
- **Skenario yang sudah lewat:** kalau harga terkini sudah melewati pemicu, rencana ditandai `passed` dan peluangnya
  dinyatakan tidak berlaku.
- **Saham Indonesia:** level mengikuti fraksi harga, satu lot 100 lembar, sinyal turun menjadi HINDARI, bukan short.

## Chart

Candle, EMA 20/50/200, volume, garis support dan resistance, trendline, label swing (HH/HL/LH/LL), kerucut rentang 80%,
dan kotak rencana (entry, SL, TP1-3). Di bawah chart ada kartu tiap rencana berisi harga, peluang kena TP, dan peluang
profit. Dua kotak saat TUNGGU, satu saat SIAP.

## Pertanyaan lanjutan

Hasil tool tersimpan di sesi, jadi Claude menjawab dari angka yang sama selama sesi hidup. Timeframe atau simbol lain,
atau harga yang sudah bergerak, memanggil tool lagi. Laporan menyertakan alasan level dan ukuran risiko per unit supaya
pertanyaan seperti "kenapa SL di situ" dan "berapa lot" terjawab. Friday tidak menentukan berapa uang orang harus
dipertaruhkan: ia menghitung memakai modal dan persen risiko dari orang itu sendiri.

## Regulasi

POJK 6/2026 mewajibkan izin penasihat investasi untuk rekomendasi produk pasar modal. Sumber yang dibaca adalah berita
dan ringkasan, bukan teks resmi, dan tidak ada yang membahas bot pribadi. Website dan katalog menunggu keputusan Albert
setelah cek ke OJK atau konsultan hukum.
