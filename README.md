# 🎮 Coret-Coret — Backend (Cloudflare Workers + Durable Objects)

## Deploy ke Cloudflare Workers

### 1. Install Wrangler
```bash
npm install
```

### 2. Login Cloudflare
```bash
npx wrangler login
```

### 3. Deploy
```bash
npm run deploy
```

Setelah deploy, kamu akan dapat URL seperti:
```
https://coret-coret-backend.YOUR-SUBDOMAIN.workers.dev
```

**Simpan URL ini** — akan dipakai di frontend!

---

## Struktur File

```
coret-backend/
├── wrangler.toml        ← Konfigurasi Cloudflare Workers
├── package.json
└── src/
    ├── index.js         ← Entry point Worker (routing)
    └── gameRoom.js      ← Durable Object (game logic + WebSocket)
```

## WebSocket Endpoint

```
wss://coret-coret-backend.YOUR-SUBDOMAIN.workers.dev/ws/ROOMCODE?name=NamaPemain
```
