# Analisis Teknikal Pasar: Rencana Implementasi

**Goal:** tool `market_analysis` untuk kontak Friday, sesuai `docs/superpowers/specs/2026-11-01-market-analysis-design.md`.

**Eksekusi:** inline di satu sesi, karena modulnya saling bergantung. Rencana ini ringkas dan sengaja tidak menyalin kode,
karena kode dan test ditulis bersamaan.

**Tech Stack:** TypeScript, `node:test`, sharp yang sudah ada. Tidak ada dependency atau layanan berbayar baru.

## Global Constraints

- Tidak commit, push, atau deploy tanpa permintaan Albert.
- Edit README.md, src/bot.ts, dan feature-map.json harus sempit, karena file itu berisi pekerjaan `/umumkan` yang belum
  di-commit.
- Jalankan perintah lokal tanpa `ANTHROPIC_BASE_URL`, dan jangan pernah `npm start` di Mac ini.

## Tasks

1. **Indikator** (`src/market/indicators.ts`). Test: nilai hitung tangan, dan nilai lama tidak berubah saat data bertambah.
2. **Data** (`src/market/candles.ts`). Test: parsing timeframe, pemetaan simbol, candle tertutup, penggabungan, Yahoo 404
   dan 429, urutan cadangan Binance, paginasi.
3. **Analisis** (`src/market/analysis.ts`). Test: hasil trade buatan (TP, SL, satu candle, gap, biaya), Wilson, tanpa
   intip masa depan, status, fraksi harga IDX, laporan tanpa janji profit.
4. **Chart** (`src/market/chart.ts`). Test: PNG valid dengan ukuran benar, level ikut tergambar.
5. **Tool dan prompt** (`src/tools.ts`, `src/prompt.ts`). Test: hanya kontak, chart terkirim, chart gagal tetap ada teks,
   pertanyaan lanjutan menerima laporan yang sama di riwayat.
6. **Dokumentasi** (`src/welcome.ts`, `src/bot.ts` /help, `README.md`, feature-map `pending`).
7. **Verifikasi**: `npm test`, `npm run typecheck`, data asli di lima pasar, lihat gambarnya, satu percakapan Claude asli.
