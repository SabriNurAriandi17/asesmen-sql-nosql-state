# State Ledger — Asesmen Manajemen State Client-side (SQL + NoSQL)

Aplikasi demo untuk Sub-CPMK-3.3: menerapkan manajemen state client-side melalui
kombinasi database **SQL** (server) dan **NoSQL** (client), sekaligus pola
**sinkronisasi client–server**.

## Struktur Proyek

```
project/
├── server/              # Backend SQL (Express + SQLite via better-sqlite3)
│   ├── server.js         # REST API CRUD + endpoint /api/sync
│   ├── package.json
│   └── database.db       # dibuat otomatis saat pertama kali dijalankan
└── client/               # Frontend murni (HTML/CSS/JS, tanpa build tool)
    ├── index.html
    ├── style.css
    └── app.js             # IndexedDB (NoSQL) + LocalStorage (state UI) + fetch ke API
```

## Cara Menjalankan

**1. Jalankan server SQL**
```bash
cd server
npm install
npm start
```
Server berjalan di `http://localhost:3001`. Database SQLite (`database.db`)
otomatis dibuat berikut tabel `tasks` dan tiga data contoh.

**2. Jalankan client**

Buka `client/index.html` langsung di browser, **atau** sajikan lewat server
statis sederhana agar tidak ada isu CORS/file:// pada beberapa browser:
```bash
cd client
npx serve .
# atau: python3 -m http.server 5500
```
Lalu buka `http://localhost:5500` (atau port yang ditampilkan).

> Pastikan server (langkah 1) sudah berjalan sebelum menekan tombol **Sinkronkan**.

## Konsep yang Didemonstrasikan

| Lapisan | Teknologi | Peran |
|---|---|---|
| **SQL** | SQLite (`better-sqlite3`) via REST API Express | Sumber kebenaran data, operasi CRUD relasional (`INSERT`, `SELECT`, `UPDATE`, soft-`DELETE`) memakai *prepared statements*. |
| **NoSQL** | IndexedDB (object store `tasks` + `pending_ops`) | Cache dokumen JSON di browser, membuat UI tetap responsif walau offline (pola *offline-first*). `pending_ops` menerapkan pola *outbox* untuk antrean perubahan. |
| **State UI** | LocalStorage | Preferensi ringan yang tidak perlu tersinkron ke server: tema, filter aktif, waktu sinkron terakhir. |
| **Sinkronisasi** | `POST /api/sync` | Client mengirim `pending_ops` → server menerapkan dengan strategi *last-write-wins* berbasis `updated_at` → server membalas seluruh perubahan sejak `since` → client memperbarui IndexedDB & `lastSync` di LocalStorage. |

### Alur data (offline-first)

1. Setiap aksi CRUD dari UI **langsung** ditulis ke IndexedDB (optimistic
   update) agar antarmuka terasa instan, terlepas dari status koneksi.
2. Operasi yang sama dicatat sebagai entri di object store `pending_ops`.
3. Saat online / tombol **Sinkronkan** ditekan, `pending_ops` dikirim ke
   `POST /api/sync`. Server menerapkannya ke SQLite lalu mengembalikan semua
   baris yang berubah sejak sinkronisasi terakhir (`since`, disimpan di
   LocalStorage).
4. Client menulis ulang IndexedDB sesuai hasil dari server dan mengosongkan
   `pending_ops` — kedua sisi kini konsisten.

Panel **Storage Inspector** di bagian atas UI menampilkan kondisi ketiga
lapisan ini secara real-time (jumlah baris SQL, jumlah dokumen IndexedDB +
antrean pending, dan isi mentah LocalStorage) — berguna untuk verifikasi saat
presentasi/asesmen.

## Ide Pengembangan Lanjutan (opsional, untuk nilai tambah)

- Tambahkan autentikasi user agar setiap user punya `tasks` sendiri di SQL.
- Ganti strategi konflik dari *last-write-wins* menjadi *merge* per field.
- Tambahkan Service Worker agar aplikasi benar-benar bisa dibuka saat offline
  penuh (saat ini HTML/CSS/JS tetap perlu dimuat sekali dari jaringan/disk).
- Migrasikan backend dari SQLite ke PostgreSQL/MySQL untuk skenario multi-user.
