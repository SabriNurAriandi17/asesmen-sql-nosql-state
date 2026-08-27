/**
 * ============================================================================
 *  APP.JS — Manajemen State Client-side (SQL + NoSQL)
 * ----------------------------------------------------------------------------
 *  Tiga lapisan penyimpanan yang didemonstrasikan:
 *
 *  1) SQL (server, via REST API)  -> modul `api`
 *     Sumber kebenaran data. Semua perubahan pada akhirnya harus tersimpan
 *     di sini melalui operasi CRUD (POST/PUT/DELETE/GET).
 *
 *  2) IndexedDB (client, NoSQL)   -> modul `idb`
 *     Menyimpan salinan data (cache) berbentuk dokumen JSON, plus antrean
 *     `pending_ops` untuk perubahan yang dibuat saat offline. Ini adalah
 *     "state" utama yang dibaca UI, agar aplikasi tetap responsif walau
 *     server lambat/tidak terjangkau (offline-first).
 *
 *  3) LocalStorage (client, key-value) -> modul `ls`
 *     Menyimpan preferensi ringan yang TIDAK perlu disinkron ke server:
 *     tema, filter aktif, dan timestamp sinkronisasi terakhir.
 * ============================================================================
 */

const API_BASE = "http://localhost:3001/api";

/* ============================================================================
 * 1) MODUL LOCALSTORAGE — state UI sederhana
 * ========================================================================== */
const ls = {
  KEYS: { theme: "sl_theme", filter: "sl_filter", lastSync: "sl_last_sync" },

  get(key, fallback = null) {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  },
  set(key, value) {
    localStorage.setItem(key, value);
    renderStorageInspector(); // setiap perubahan langsung tercermin di panel inspector
  },
  getTheme() { return this.get(this.KEYS.theme, "dark"); },
  setTheme(t) { this.set(this.KEYS.theme, t); },
  getFilter() { return this.get(this.KEYS.filter, "all"); },
  setFilter(f) { this.set(this.KEYS.filter, f); },
  getLastSync() { return this.get(this.KEYS.lastSync, "0"); },
  setLastSync(ts) { this.set(this.KEYS.lastSync, String(ts)); },

  /** Mengambil semua key milik aplikasi ini untuk ditampilkan di inspector. */
  snapshot() {
    const out = {};
    Object.values(this.KEYS).forEach((k) => (out[k] = localStorage.getItem(k)));
    return out;
  },
};

/* ============================================================================
 * 2) MODUL INDEXEDDB — NoSQL document store di browser
 * ========================================================================== */
const idb = (() => {
  const DB_NAME = "state_ledger_db";
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const database = e.target.result;
        // Object store 'tasks': dokumen JSON, key = id (mirip koleksi NoSQL)
        if (!database.objectStoreNames.contains("tasks")) {
          const store = database.createObjectStore("tasks", { keyPath: "id" });
          store.createIndex("status", "status", { unique: false });
        }
        // Object store 'pending_ops': antrean perubahan offline yang belum
        // dikirim ke server SQL (pola outbox untuk sinkronisasi).
        if (!database.objectStoreNames.contains("pending_ops")) {
          database.createObjectStore("pending_ops", { keyPath: "op_id", autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(storeName, mode) {
    return open().then((database) => database.transaction(storeName, mode).objectStore(storeName));
  }

  return {
    async getAllTasks() {
      const store = await tx("tasks", "readonly");
      return new Promise((res, rej) => {
        const req = store.getAll();
        req.onsuccess = () => res(req.result.sort((a, b) => b.updated_at - a.updated_at));
        req.onerror = () => rej(req.error);
      });
    },
    async putTask(task) {
      const store = await tx("tasks", "readwrite");
      return new Promise((res, rej) => {
        const req = store.put(task);
        req.onsuccess = () => res();
        req.onerror = () => rej(req.error);
      });
    },
    async deleteTask(id) {
      const store = await tx("tasks", "readwrite");
      return new Promise((res, rej) => {
        const req = store.delete(id);
        req.onsuccess = () => res();
        req.onerror = () => rej(req.error);
      });
    },
    async clearTasks() {
      const store = await tx("tasks", "readwrite");
      return new Promise((res, rej) => {
        const req = store.clear();
        req.onsuccess = () => res();
        req.onerror = () => rej(req.error);
      });
    },
    async addPendingOp(op) {
      const store = await tx("pending_ops", "readwrite");
      return new Promise((res, rej) => {
        const req = store.add(op);
        req.onsuccess = () => res();
        req.onerror = () => rej(req.error);
      });
    },
    async getAllPendingOps() {
      const store = await tx("pending_ops", "readonly");
      return new Promise((res, rej) => {
        const req = store.getAll();
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
    },
    async clearPendingOps() {
      const store = await tx("pending_ops", "readwrite");
      return new Promise((res, rej) => {
        const req = store.clear();
        req.onsuccess = () => res();
        req.onerror = () => rej(req.error);
      });
    },
  };
})();

/* ============================================================================
 * 3) MODUL API — komunikasi ke server SQL (SQLite via Express)
 * ========================================================================== */
const api = {
  async ping() {
    const res = await fetch(`${API_BASE}/tasks`, { method: "GET" });
    if (!res.ok) throw new Error("ping failed");
    return true;
  },
  async fetchAll() {
    const res = await fetch(`${API_BASE}/tasks`);
    if (!res.ok) throw new Error("Gagal mengambil data dari SQL server");
    return res.json();
  },
  async sync(ops, since) {
    const res = await fetch(`${API_BASE}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ops, since }),
    });
    if (!res.ok) throw new Error("Sinkronisasi ke SQL server gagal");
    return res.json();
  },
};

/* ============================================================================
 * 4) STATE APLIKASI IN-MEMORY (sumber render UI, hasil dari IndexedDB)
 * ========================================================================== */
let tasks = [];
let editingId = null;
let isOnline = navigator.onLine;

/* ============================================================================
 * 5) RENDER
 * ========================================================================== */
function log(message, type = "local") {
  const el = document.getElementById("syncLog");
  const line = document.createElement("div");
  line.className = `log-line ${type}`;
  const time = new Date().toLocaleTimeString("id-ID", { hour12: false });
  line.innerHTML = `<strong>${time}</strong> — ${message}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function renderConnStatus() {
  const dot = document.getElementById("connDot");
  const label = document.getElementById("connLabel");
  dot.className = "dot " + (isOnline ? "dot--online" : "dot--offline");
  label.textContent = isOnline ? "Server SQL terjangkau" : "Offline — mode IndexedDB";
}

async function renderStorageInspector() {
  document.getElementById("idbCount").textContent = tasks.length;
  const pending = await idb.getAllPendingOps();
  document.getElementById("pendingCount").textContent = pending.length;
  document.getElementById("idbMeta").innerHTML = `antrean sinkron: <span>${pending.length}</span>`;
  document.getElementById("lsPreview").textContent = JSON.stringify(ls.snapshot(), null, 2);
}

function renderSqlMeta(text) {
  document.getElementById("sqlMeta").textContent = text;
}

function renderTasks() {
  const filter = ls.getFilter();
  const list = document.getElementById("taskList");
  const empty = document.getElementById("emptyState");
  list.innerHTML = "";

  const filtered = filter === "all" ? tasks : tasks.filter((t) => t.status === filter);
  empty.hidden = filtered.length !== 0;

  filtered.forEach((t) => {
    const li = document.createElement("li");
    li.className = `task-item status-${t.status}${t._pending ? " is-pending" : ""}`;
    li.innerHTML = `
      <div class="task-item__body">
        <p class="task-item__title">${escapeHtml(t.title)}</p>
        ${t.description ? `<p class="task-item__desc">${escapeHtml(t.description)}</p>` : ""}
        <div class="task-item__meta">
          <span class="tag tag--pri-${t.priority}">${t.priority}</span>
          <select class="status-select" data-id="${t.id}">
            <option value="todo" ${t.status === "todo" ? "selected" : ""}>belum</option>
            <option value="doing" ${t.status === "doing" ? "selected" : ""}>berjalan</option>
            <option value="done" ${t.status === "done" ? "selected" : ""}>selesai</option>
          </select>
          ${t._pending ? `<span class="tag tag--pending">belum sync</span>` : ""}
        </div>
      </div>
      <div class="task-item__actions">
        <button class="icon-btn" data-action="edit" data-id="${t.id}" title="Edit">✎</button>
        <button class="icon-btn" data-action="delete" data-id="${t.id}" title="Hapus">🗑</button>
      </div>
    `;
    list.appendChild(li);
  });

  document.querySelectorAll(".chip").forEach((chip) => {
    chip.classList.toggle("is-active", chip.dataset.filter === filter);
  });

  renderStorageInspector();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/* ============================================================================
 * 6) OPERASI CRUD — DITULIS DULU KE INDEXEDDB (optimistic), LALU DIANTRE
 *    UNTUK SYNC KE SQL. Inilah pola "client-side state management".
 * ========================================================================== */
async function loadFromIndexedDB() {
  tasks = await idb.getAllTasks();
  renderTasks();
}

async function createTask({ title, description, priority }) {
  const now = Date.now();
  const task = {
    id: crypto.randomUUID(),
    title,
    description,
    priority,
    status: "todo",
    created_at: now,
    updated_at: now,
    _pending: true,
  };
  await idb.putTask(task);
  await idb.addPendingOp({ type: "upsert", ...stripPendingFlag(task) });
  log(`<span style="color:var(--nosql)">IndexedDB</span>: dokumen "<strong>${escapeHtml(title)}</strong>" dibuat (menunggu sync)`, "nosql");
  await loadFromIndexedDB();
}

async function updateTask(id, patch) {
  const existing = tasks.find((t) => t.id === id);
  if (!existing) return;
  const updated = { ...existing, ...patch, updated_at: Date.now(), _pending: true };
  await idb.putTask(updated);
  await idb.addPendingOp({ type: "upsert", ...stripPendingFlag(updated) });
  log(`<span style="color:var(--nosql)">IndexedDB</span>: dokumen "<strong>${escapeHtml(updated.title)}</strong>" diperbarui (menunggu sync)`, "nosql");
  await loadFromIndexedDB();
}

async function deleteTask(id) {
  const existing = tasks.find((t) => t.id === id);
  await idb.deleteTask(id);
  await idb.addPendingOp({ type: "delete", id, updated_at: Date.now() });
  log(`<span style="color:var(--nosql)">IndexedDB</span>: dokumen "<strong>${escapeHtml(existing?.title || id)}</strong>" dihapus (menunggu sync)`, "nosql");
  await loadFromIndexedDB();
}

function stripPendingFlag(t) {
  const { _pending, ...rest } = t;
  return rest;
}

/* ============================================================================
 * 7) SINKRONISASI — mengirim pending_ops ke SQL, lalu menarik data terbaru
 * ========================================================================== */
async function runSync() {
  const btn = document.getElementById("syncBtn");
  const icon = btn.querySelector(".sync-icon");
  btn.disabled = true;
  icon.classList.add("spin");

  try {
    await api.ping();
    isOnline = true;
    renderConnStatus();

    const pendingOps = await idb.getAllPendingOps();
    log(`Memulai sinkronisasi — ${pendingOps.length} operasi tertunda dikirim ke <span style="color:var(--sql)">SQL server</span>`, "sql");

    const since = Number(ls.getLastSync());
    const { server_time, changed } = await api.sync(pendingOps, since);

    // Terapkan hasil dari server ke IndexedDB (termasuk item yang dihapus)
    for (const row of changed) {
      if (row.deleted) {
        await idb.deleteTask(row.id);
      } else {
        await idb.putTask({ ...row, _pending: false });
      }
    }

    await idb.clearPendingOps();
    ls.setLastSync(server_time);

    const sqlAll = await api.fetchAll();
    renderSqlMeta(`${sqlAll.length} baris · sync terakhir ${new Date(server_time).toLocaleTimeString("id-ID")}`);
    document.getElementById("sqlCount").textContent = sqlAll.length;

    log(`Sinkronisasi selesai — <strong>${changed.length}</strong> perubahan diterapkan dari <span style="color:var(--sql)">SQL</span> ke <span style="color:var(--nosql)">IndexedDB</span>`, "sql");

    await loadFromIndexedDB();
  } catch (err) {
    isOnline = false;
    renderConnStatus();
    log(`Sinkronisasi gagal: ${err.message}. Data tetap aman di IndexedDB.`, "err");
  } finally {
    btn.disabled = false;
    icon.classList.remove("spin");
  }
}

/* ============================================================================
 * 8) EVENT WIRING
 * ========================================================================== */
function initTheme() {
  const theme = ls.getTheme();
  document.body.classList.toggle("theme-light", theme === "light");
  document.getElementById("themeToggle").checked = theme === "light";
}

document.getElementById("themeToggle").addEventListener("change", (e) => {
  const theme = e.target.checked ? "light" : "dark";
  document.body.classList.toggle("theme-light", theme === "light");
  ls.setTheme(theme);
  log(`<span style="color:var(--local)">LocalStorage</span>: preferensi tema diubah ke "${theme}"`, "local");
});

document.getElementById("filterTabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  ls.setFilter(btn.dataset.filter);
  log(`<span style="color:var(--local)">LocalStorage</span>: filter aktif diubah ke "${btn.dataset.filter}"`, "local");
  renderTasks();
});

document.getElementById("taskForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.getElementById("taskTitle").value.trim();
  const description = document.getElementById("taskDesc").value.trim();
  const priority = document.getElementById("taskPriority").value;
  if (!title) return;

  if (editingId) {
    await updateTask(editingId, { title, description, priority });
    exitEditMode();
  } else {
    await createTask({ title, description, priority });
  }
  document.getElementById("taskForm").reset();
  document.getElementById("taskPriority").value = "normal";
});

document.getElementById("taskList").addEventListener("click", async (e) => {
  const btn = e.target.closest(".icon-btn");
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.action === "delete") {
    if (confirm("Hapus tugas ini?")) await deleteTask(id);
  } else if (btn.dataset.action === "edit") {
    enterEditMode(id);
  }
});

document.getElementById("taskList").addEventListener("change", async (e) => {
  if (!e.target.classList.contains("status-select")) return;
  await updateTask(e.target.dataset.id, { status: e.target.value });
});

document.getElementById("cancelEditBtn").addEventListener("click", exitEditMode);
document.getElementById("syncBtn").addEventListener("click", runSync);

function enterEditMode(id) {
  const t = tasks.find((x) => x.id === id);
  if (!t) return;
  editingId = id;
  document.getElementById("taskId").value = id;
  document.getElementById("taskTitle").value = t.title;
  document.getElementById("taskDesc").value = t.description || "";
  document.getElementById("taskPriority").value = t.priority;
  document.getElementById("submitBtn").textContent = "Simpan Perubahan";
  document.getElementById("cancelEditBtn").hidden = false;
  document.getElementById("taskTitle").focus();
}

function exitEditMode() {
  editingId = null;
  document.getElementById("taskForm").reset();
  document.getElementById("taskPriority").value = "normal";
  document.getElementById("submitBtn").textContent = "+ Tambah Tugas";
  document.getElementById("cancelEditBtn").hidden = true;
}

window.addEventListener("online", () => { isOnline = true; renderConnStatus(); });
window.addEventListener("offline", () => { isOnline = false; renderConnStatus(); });

/* ============================================================================
 * 9) INISIALISASI
 * ========================================================================== */
(async function init() {
  initTheme();
  renderConnStatus();
  log("Aplikasi dimuat. Membaca cache dari <span style='color:var(--nosql)'>IndexedDB</span>…", "nosql");
  await loadFromIndexedDB();

  // Jika IndexedDB masih kosong (pertama kali dibuka), coba tarik dari SQL
  if (tasks.length === 0) {
    try {
      await api.ping();
      isOnline = true;
      renderConnStatus();
      await runSync();
    } catch {
      isOnline = false;
      renderConnStatus();
      log("Server SQL belum aktif. Jalankan 'npm start' di folder /server, lalu klik Sinkronkan.", "err");
    }
  } else {
    // Coba sync di background tanpa mengganggu jika server belum jalan
    api.ping().then(runSync).catch(() => {
      isOnline = false;
      renderConnStatus();
    });
  }
})();
