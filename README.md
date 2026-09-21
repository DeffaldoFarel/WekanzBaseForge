# WekanzBaseForge ⚡

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.5.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![SQLite](https://img.shields.io/badge/Database-SQLite%20WAL-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![Next.js](https://img.shields.io/badge/Dashboard-Next.js%2015-000000?logo=next.js&logoColor=white)](https://nextjs.org/)
[![Tests](https://img.shields.io/badge/Tests-695%20Passing-brightgreen?logo=node.js&logoColor=white)](https://github.com/DeffaldoFarel/WekanzBaseForge)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**WekanzBaseForge** is an open-source, production-hardened **Backend-as-a-Service (BaaS)** engineered for high performance, deterministic reliability, and complete data ownership. Built natively with modern Node.js and TypeScript, BaseForge delivers multi-tenant SQL database collections, end-user authentication, V8-isolated serverless functions, file storage, outbound webhooks, and real-time streaming — all managed via an intuitive, full-width Next.js 15 dashboard.

---

## 🌟 Key Architecture & Highlights

```
                       ┌───────────────────────────────────────────────┐
                       │     WekanzBaseForge Platform Engine (Core)    │
                       │  HTTP Core (node:http) · Custom Async Router  │
                       │   Streaming DoS Guards · LRU Connection Pool  │
                       └──────┬────────────────┬──────────────┬────────┘
                              │                │              │
         ┌────────────────────▼──┐   ┌─────────▼────────┐   ┌─▼──────────────────┐
         │  Project "Production" │   │  Project "Auth"  │   │  Project "Staging" │
         │   data/projects/p1/   │   │ data/projects/p2/│   │  data/projects/p3/ │
         │      ├── data.db      │   │   ├── data.db    │   │     ├── data.db    │
         │      └── files/       │   │   └── files/     │   │     └── files/     │
         └───────────────────────┘   └──────────────────┘   └────────────────────┘
```

### 1. 🗄️ True Multi-Tenant SQLite Architecture (Zero-Config Isolation)
* **Dedicated Database per Project:** Every project operates with its own SQLite database (`data.db`) running in **Write-Ahead Logging (WAL)** mode with connection caching and passive checkpoints.
* **Extreme Isolation:** No shared tables across tenants. Backing up, migrating, or deleting a project is as atomic and safe as copying or removing a single file on disk.
* **Auto Connection Pooling (LRU):** Custom connection manager caps concurrent active handles (100 DBs) to guarantee zero `EMFILE` exhaustion on high-density multi-tenant servers.

### 2. ⚡ V8 Isolated Serverless Engine (`isolated-vm`)
* **True Process Sandboxing:** Functions run in dedicated V8 Isolates with real memory bounds (16 MB – 256 MB) and strict execution timeouts (up to 120s), immune to prototype pollution or host escapes.
* **Zero-Network In-Process `$db` Access:** Functions execute native CRUD queries directly in SQLite memory without HTTP overhead, credentials, or network latency.
* **Encrypted Secrets (`$env`) & Shared Modules (`$lib`):** AES-256-GCM encrypted secrets injected safely into the isolate sandbox, paired with a reusable CommonJS module registry.
* **Event-Driven Triggers & Schedulers:** Execute on database mutations (`create`, `update`, `delete` with pre/post snapshots) or on cron schedules with native IANA timezone evaluation (e.g., `Asia/Jakarta`, `America/New_York`, `UTC`).

### 3. 🔐 Enterprise-Grade Authentication & Identity
* **Cryptographic Security:** Scrypt and Argon2 password hashing with timing-safe comparison.
* **Multi-Provider OAuth2:** Turnkey social authentication for **Google, GitHub, Microsoft, Discord, GitLab, and Facebook**.
* **Two-Factor Authentication (TOTP MFA):** Native RFC 6238 implementation with QR enrollment, timed challenge tokens, and single-use hashed recovery codes.
* **Granular Profile Schemas (Ops-16):** Extend user profiles with strongly-typed custom attributes (`role`, `tier`, `metadata`) without breaking base auth schema.
* **Atomic Rate Limiting:** Persistent sliding/fixed-window rate limiting backed by Redis and atomic Lua scripts, featuring automatic memory fallback for standalone dev instances.

### 4. 📡 Realtime Subscriptions & Outbound Webhooks
* **Realtime SSE Hub:** Native Server-Sent Events with post-connection auth upgrades and record-level topic filters (`posts/*`, `comments/abc123`).
* **Reliable Reverse API Webhooks:** Outbound HTTP push notifications with HMAC-SHA256 payload signatures, automatic 3-tier exponential backoff retries, and comprehensive delivery audit logs.

### 5. 🖥️ Modern Next.js 15 Console
* **Full-Width Fluid UI:** Consistent 100% viewport workspace built with Tailwind CSS and shadcn/ui components.
* **Database Studio:** Visual collection schema builder, relation graph expander, full-text search (FTS5), SQL query editor, and JSON batch importer/exporter.
* **Session Resilience:** Automatic session expiration handling with zero-data-loss return redirects.

---

## 🧰 Tech Stack

| Domain | Technology | Purpose & Rationale |
|---|---|---|
| **Runtime** | Node.js (>= 22.5.0) | Utilizes native `node:sqlite` and native WebCrypto |
| **Language** | TypeScript (Strict) | End-to-end type safety across server, client, and UI |
| **Database Engine** | Built-in `node:sqlite` | Battle-tested C SQLite engine with WAL mode and zero external dependencies |
| **HTTP Routing** | `node:http` (Custom Router) | High-performance pattern matcher with payload limiters & error boundaries |
| **Sandboxing** | `isolated-vm` | Production-grade V8 Isolates with strict memory limits and async timeouts |
| **Tokens & Crypto** | `jose` & `node:crypto` | WebCrypto-standard JWT verification and OWASP-grade scrypt hashing |
| **File Parser** | `@fastify/busboy` | Streaming, memory-safe multipart parser for uploads up to 100MB |
| **Rate Limiter** | `ioredis` + Lua (Memory fallback) | Atomic, multi-instance ready fixed-window rate limiter |
| **Dashboard** | Next.js 15 + React 19 + Tailwind CSS | Fluid, responsive multi-tenant administrative workspace |
| **Testing** | `node:test` + `tsx` | 695 passing unit and integration tests |

---

## 📊 Feature Comparison

| Feature | WekanzBaseForge | PocketBase | Supabase | Appwrite |
|---|:---:|:---:|:---:|:---:|
| **Language & Architecture** | **TypeScript / Node.js** | Go (Single binary) | PostgreSQL + Go/Node | Docker Container Stack |
| **Multi-Tenancy** | **Native per-file SQLite** | Single tenant / multi-process | PostgreSQL Schemas | Single database shared |
| **Serverless Sandbox** | **V8 Isolate (`isolated-vm`)** | Go hooks / JS VM (no memory cap) | Deno Edge (External network) | OpenRuntimes (Docker) |
| **In-Process Database Access** | **✅ Zero latency via `$db`** | ✅ Via Go / JS | ❌ Over HTTP/Postgres pool | ❌ Over HTTP |
| **Multi-Provider OAuth2** | **✅ 7 Providers Built-in** | ✅ Extensive | ✅ Extensive | ✅ Extensive |
| **TOTP Multi-Factor Auth** | **✅ RFC 6238 Built-in** | ❌ (Custom plugins) | ✅ Built-in | ✅ Built-in |
| **Realtime Subscriptions** | **✅ Native SSE** | ✅ SSE | ✅ WebSocket (Realtime server) | ✅ WebSocket |
| **Outbound Webhooks** | **✅ HMAC-SHA256 + Retries** | ❌ (Requires hooks code) | ✅ Database webhooks | ✅ Webhooks engine |
| **Memory Footprint** | **~80 MB – 140 MB** | ~30 MB – 60 MB | ~1.5 GB – 4 GB | ~2 GB – 4 GB |

---

## 🚀 Quick Start

### 📋 Prerequisites
* **Node.js >= 22.5.0** (Required for built-in `node:sqlite`)
* **npm >= 10**

### 1. Clone & Install
```bash
git clone https://github.com/DeffaldoFarel/WekanzBaseForge.git
cd WekanzBaseForge

# Install dependencies for both server and dashboard (via npm workspaces)
npm install
```

### 2. Run in Development Mode

Open two terminal sessions:

**Terminal 1 — Core Server (Backend API):**
```bash
npm run dev:server
# → Server running on http://localhost:5100
# → Health status: http://localhost:5100/api/health
```

**Terminal 2 — Admin Dashboard (Console UI):**
```bash
npm run dev:dashboard
# → Console running on http://localhost:7701
```

### 3. Master Admin Onboarding
1. Open your browser and navigate to **`http://localhost:7701`**.
2. BaseForge will automatically detect a fresh installation and direct you to **First-Time Setup** (`/signup`).
3. Create your Master Admin credentials. Your password will be securely hashed with OWASP-recommended `scrypt` parameters and stored in `data/platform.db`.
4. Once completed, the setup endpoint automatically locks (`403 SETUP_COMPLETED`), and you will be redirected to the Project Dashboard.

### 4. Running the Test Suite
BaseForge includes comprehensive end-to-end integration and unit tests covering SQLite concurrency, ACID transactions, V8 isolate execution, token lifecycle, and authentication:

```bash
cd server
npm test
# → 695 tests passing (0 fail) across 33 test suites
```

---

## 📦 Client SDK

BaseForge provides an official lightweight TypeScript client (`@wekanz/baseforge`):

```bash
npm install @wekanz/baseforge
```

```typescript
import { BaseForgeClient } from '@wekanz/baseforge';

const client = new BaseForgeClient({
  baseUrl: 'https://baseforge.wekanz.id',
  projectId: 'my-project-id',
});

// 1. Authenticate End-User
const auth = await client.auth.login('user@domain.com', 'securePassword123');

// 2. Query Collection with Filters & Expand
const articles = await client.collection('articles').list({
  page: 1,
  perPage: 20,
  filter: 'published = true && rating >= 4.5',
  sort: '-created',
  expand: 'author,categories',
});

// 3. Realtime Subscription (SSE with Auto-Reconnect)
const unsubscribe = client.realtime.subscribe('articles', (event) => {
  console.log('Record mutation:', event.action, event.record);
});
```

---

## 🚢 Production Deployment

BaseForge is designed to run efficiently on standard Linux VPS instances (Ubuntu 22.04 / 24.04) using `systemd` and `Caddy` as a reverse proxy:

### 1. Build Artifacts
```bash
# Build Server
cd server && npm run build

# Build Dashboard
cd ../dashboard && npm run build
```

### 2. Example Systemd Service Configuration

**`/etc/systemd/system/baseforge-server.service`:**
```ini
[Unit]
Description=WekanzBaseForge Server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/WekanzBaseForge/server
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=5100
Environment=DATA_DIR=/home/ubuntu/WekanzBaseForge/data

[Install]
WantedBy=multi-user.target
```

**`/etc/systemd/system/baseforge-dashboard.service`:**
```ini
[Unit]
Description=WekanzBaseForge Dashboard
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/WekanzBaseForge/dashboard
ExecStart=/usr/bin/npx next start -p 7701
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### 3. Example Caddy Configuration (`/etc/caddy/Caddyfile`)
```caddy
baseforge.wekanz.id {
    encode zstd gzip

    # Route API requests to Core Backend
    handle /api/* {
        reverse_proxy localhost:5100
    }

    # Route File Serving to Core Backend
    handle /api/files/* {
        reverse_proxy localhost:5100
    }

    # Route all other web traffic to Dashboard UI
    handle {
        reverse_proxy localhost:7701
    }
}
```

---

## 📁 Repository Structure

```
WekanzBaseForge/
├── server/                         # BaseForge Core Engine (API & Runtime)
│   ├── src/
│   │   ├── api/                    # Admin and Client REST Endpoints
│   │   ├── auth/                   # Password Hashing, JWT, MFA, & OAuth2
│   │   ├── core/                   # SQLite Manager, V8 Sandbox, Realtime & Schedulers
│   │   ├── platform/               # Platform DB & Admin Credentials
│   │   └── index.ts                # Application Entry Point & Lifecycles
│   └── tests/                      # 695 Unit and Integration Tests
├── dashboard/                      # Next.js 15 Full-Width Admin Console
│   ├── app/                        # App Router (Overview, Studio, Auth, Functions)
│   ├── components/                 # Reusable UI & Studio Components
│   └── lib/                        # API Client & State Managers
├── packages/
│   └── client/                     # Official TypeScript Client SDK
├── data/                           # Data storage root (platform.db + project databases)
└── docs/                           # In-depth architectural & API specifications
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE) — free for personal and commercial use.

Built with ❤️ by **Farel Deffaldo** and the **Wekanz** team.
