# M15u — Dashboard: Function Editor + Runner

> **Konsep:** kelola functions dari UI — editor kode, badge schedule/trigger, toggle enabled, dan Run panel dengan output + console logs.

## 🎯 Fitur

```
📋 Daftar function:
   nama + badge (⏰ cron / 🔗 collection:actions / ▶ callable) + timeout
   toggle enabled (checkbox) · ▶ Run · Edit · Hapus

✏️ Editor modal (create & edit):
   name · code (textarea mono, spellcheck off) · timeoutMs
   schedule (cron) · triggers (dropdown collection + checkbox actions)

▶️ Run panel inline:
   input req.body (JSON) → ✅/❌ + durasi + result JSON + console logs
   (admin execute — tetap bisa walau disabled, untuk debug)
```

## 📁 Perubahan

```
lib/api.ts                          → listFunctions/createFunction/
                                      updateFunction/deleteFunction/
                                      executeFunction/FunctionExecResult
app/projects/[id]/functions/page.tsx → halaman lengkap (menggantikan
                                      placeholder [service])
```

## 📝 Aha! Moments

### Aha! #1 — Run panel = Cloud Functions console pribadi
Firebase punya console dengan tab "Testing" untuk invoke function + lihat
logs. Panel kita: textarea req.body → jalankan → result JSON + logs +
durasi. User melihat persis apa yang dilihat sandbox: return value,
console yang tertangkap, error message, bahkan indikator timeout.

### Aha! #2 — Toggle enabled di UI menutup lingkaran M15a
`enabled: false` di backend sudah dicek public execute (403) — di UI
kini satu checkbox: nonaktif = "un-deploy". Admin tetap bisa Run untuk
debug (mengikuti semantik server). Tidak ada halaman deploy/un-deploy
terpisah — boolean saja.

### Aha! #3 — Trigger editor memakai collection yang VALID dari server
Dropdown collection di trigger diisi dari listCollections — bukan input
bebas. Typo collection tidak mungkin; dan server tetap memvalidasi ulang
(defense in depth — UI validation adalah UX, bukan keamanan).

### Aha! #4 — textContent.includes() untuk klik tombol React
Trik browser test berulang: [...buttons].find(b => b.textContent
.includes('Run')) — bekerja untuk tombol dengan emoji/whitespace.
Dan DataTransfer trick dari M14u tetap dipakai untuk isi textarea
programmatik (setter prototype + dispatchEvent).

## ✅ Status: SELESAI — verifikasi browser nyata: create via UI → run dengan body → result + logs + toggle enabled — 2026-09-12