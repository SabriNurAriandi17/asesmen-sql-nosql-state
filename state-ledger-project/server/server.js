/**
 * ============================================================================
 *  SERVER SQL (Express + SQLite / better-sqlite3)
 * ----------------------------------------------------------------------------
 *  Peran server ini dalam proyek asesmen:
 *   - Menjadi "sumber kebenaran" (source of truth) data, disimpan dalam
 *     database relasional SQL (SQLite) melalui tabel `tasks`.
 *   - Menyediakan REST API untuk operasi CRUD standar (Create, Read,
 *     Update, Delete) yang dipanggil oleh client.
 *   - Menyediakan endpoint /api/sync yang menerima batch perubahan yang
 *     dibuat client secara offline (disimpan sementara di IndexedDB),
 *     menerapkannya ke SQL, lalu mengirim balik data terbaru agar
 *     client bisa memperbarui cache NoSQL (IndexedDB) miliknya.
 * ============================================================================
 */

const express = require("express");
const cors = require("cors");
const { DatabaseSync } = require("node:sqlite"); // modul SQLite bawaan Node.js (v22.5+)
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// 1. SETUP DATABASE SQL (SQLite)
//    Memakai node:sqlite (built-in Node.js) alih-alih better-sqlite3 agar
//    TIDAK memerlukan kompilasi native module (node-gyp / Visual Studio
//    Build Tools) — cukup Node.js saja, tanpa dependency tambahan untuk DB.
// ---------------------------------------------------------------------------
const db = new DatabaseSync(path.join(__dirname, "database.db"));
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'todo',   -- todo | doing | done
    priority    TEXT NOT NULL DEFAULT 'normal',  -- low | normal | high
    updated_at  INTEGER NOT NULL,               -- epoch ms, dipakai untuk sinkronisasi
    created_at  INTEGER NOT NULL,
    deleted     INTEGER NOT NULL DEFAULT 0      -- soft delete, penting untuk sinkronisasi
  );
`);

// Seed data contoh jika tabel masih kosong (memudahkan demo pertama kali)
const countRow = db.prepare("SELECT COUNT(*) AS c FROM tasks").get();
if (countRow.c === 0) {
  const now = Date.now();
  const seed = db.prepare(`
    INSERT INTO tasks (id, title, description, status, priority, updated_at, created_at, deleted)
    VALUES (@id, @title, @description, @status, @priority, @updated_at, @created_at, 0)
  `);
  // node:sqlite tidak punya helper db.transaction() seperti better-sqlite3,
  // jadi transaksi dibungkus manual dengan BEGIN/COMMIT/ROLLBACK.
  const seedRows = [
    {
      id: crypto.randomUUID(),
      title: "Pelajari operasi CRUD SQL",
      description: "Praktikkan SELECT, INSERT, UPDATE, DELETE pada SQLite.",
      status: "doing",
      priority: "high",
      updated_at: now,
      created_at: now,
    },
    {
      id: crypto.randomUUID(),
      title: "Implementasi IndexedDB",
      description: "Buat object store untuk cache data di sisi client.",
      status: "todo",
      priority: "normal",
      updated_at: now,
      created_at: now,
    },
    {
      id: crypto.randomUUID(),
      title: "Simpan preferensi UI di LocalStorage",
      description: "Contoh: tema (dark/light) dan filter terakhir.",
      status: "todo",
      priority: "low",
      updated_at: now,
      created_at: now,
    },
  ];
  db.exec("BEGIN");
  try {
    seedRows.forEach((r) => seed.run(r));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 2. PREPARED STATEMENTS (agar aman dari SQL Injection)
// ---------------------------------------------------------------------------
const stmts = {
  selectAll: db.prepare("SELECT * FROM tasks WHERE deleted = 0 ORDER BY updated_at DESC"),
  selectOne: db.prepare("SELECT * FROM tasks WHERE id = ?"),
  selectChangedSince: db.prepare("SELECT * FROM tasks WHERE updated_at > ? ORDER BY updated_at ASC"),
  insert: db.prepare(`
    INSERT INTO tasks (id, title, description, status, priority, updated_at, created_at, deleted)
    VALUES (@id, @title, @description, @status, @priority, @updated_at, @created_at, 0)
  `),
  update: db.prepare(`
    UPDATE tasks
    SET title = @title, description = @description, status = @status,
        priority = @priority, updated_at = @updated_at
    WHERE id = @id
  `),
  softDelete: db.prepare("UPDATE tasks SET deleted = 1, updated_at = ? WHERE id = ?"),
  upsert: db.prepare(`
    INSERT INTO tasks (id, title, description, status, priority, updated_at, created_at, deleted)
    VALUES (@id, @title, @description, @status, @priority, @updated_at, @created_at, @deleted)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      status = excluded.status,
      priority = excluded.priority,
      updated_at = excluded.updated_at,
      deleted = excluded.deleted
    WHERE excluded.updated_at >= tasks.updated_at
  `),
};

// ---------------------------------------------------------------------------
// 3. REST API - CRUD SQL MURNI
// ---------------------------------------------------------------------------

// READ - semua task aktif
app.get("/api/tasks", (req, res) => {
  res.json(stmts.selectAll.all());
});

// READ - satu task
app.get("/api/tasks/:id", (req, res) => {
  const row = stmts.selectOne.get(req.params.id);
  if (!row || row.deleted) return res.status(404).json({ error: "Task tidak ditemukan" });
  res.json(row);
});

// CREATE
app.post("/api/tasks", (req, res) => {
  const { title, description = "", status = "todo", priority = "normal" } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: "Field 'title' wajib diisi" });
  }
  const now = Date.now();
  const row = {
    id: req.body.id || crypto.randomUUID(),
    title,
    description,
    status,
    priority,
    updated_at: now,
    created_at: now,
  };
  stmts.insert.run(row);
  res.status(201).json(row);
});

// UPDATE
app.put("/api/tasks/:id", (req, res) => {
  const existing = stmts.selectOne.get(req.params.id);
  if (!existing || existing.deleted) return res.status(404).json({ error: "Task tidak ditemukan" });

  const updated = {
    id: req.params.id,
    title: req.body.title ?? existing.title,
    description: req.body.description ?? existing.description,
    status: req.body.status ?? existing.status,
    priority: req.body.priority ?? existing.priority,
    updated_at: Date.now(),
  };
  stmts.update.run(updated);
  res.json(stmts.selectOne.get(req.params.id));
});

// DELETE (soft delete, agar bisa disinkronkan ke client lain)
app.delete("/api/tasks/:id", (req, res) => {
  const existing = stmts.selectOne.get(req.params.id);
  if (!existing || existing.deleted) return res.status(404).json({ error: "Task tidak ditemukan" });
  stmts.softDelete.run(Date.now(), req.params.id);
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// 4. ENDPOINT SINKRONISASI CLIENT <-> SERVER
// ---------------------------------------------------------------------------
//
// Alur sinkronisasi (offline-first):
//  1. Client menyimpan operasi (create/update/delete) yang terjadi saat
//     offline ke dalam object store 'pending_ops' di IndexedDB.
//  2. Ketika online / user menekan tombol "Sync", client mengirim seluruh
//     pending_ops ke POST /api/sync.
//  3. Server menerapkan operasi tsb ke SQL menggunakan UPSERT
//     berbasis 'updated_at' (Last-Write-Wins) agar konflik sederhana
//     bisa ditangani secara otomatis.
//  4. Server membalas dengan seluruh data yang berubah sejak timestamp
//     terakhir client sinkron (`since`), agar client bisa memperbarui
//     cache NoSQL (IndexedDB) dan localStorage-nya.
//
app.post("/api/sync", (req, res) => {
  const { ops = [], since = 0 } = req.body;

  // node:sqlite tidak punya helper db.transaction(), jadi dibungkus manual.
  try {
    db.exec("BEGIN");
    ops.forEach((op) => {
      if (op.type === "delete") {
        const existing = stmts.selectOne.get(op.id);
        if (existing) stmts.softDelete.run(op.updated_at || Date.now(), op.id);
      } else {
        // create & update ditangani sama dengan UPSERT last-write-wins
        stmts.upsert.run({
          id: op.id,
          title: op.title,
          description: op.description || "",
          status: op.status || "todo",
          priority: op.priority || "normal",
          updated_at: op.updated_at || Date.now(),
          created_at: op.created_at || Date.now(),
          deleted: 0,
        });
      }
    });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    return res.status(500).json({ error: "Gagal menerapkan operasi sinkronisasi", detail: err.message });
  }

  const changed = stmts.selectChangedSince.all(since);
  res.json({
    server_time: Date.now(),
    changed, // termasuk yang deleted=1, supaya client tahu harus menghapusnya dari IndexedDB
  });
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`✅ Server SQL berjalan di http://localhost:${PORT}`);
  console.log(`   Database file: ${path.join(__dirname, "database.db")}`);
});
