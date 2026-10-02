<div align="center">

# Flytrap

**A self-hosted inbox that keeps every letter.**

*Point an MX record at it. Mail for the domain is accepted, stored, and sorted*  
*so you can read it — the point is to not miss anything.*

![Node 22+](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js\&logoColor=white)

![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript\&logoColor=white)

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

![Docker](https://img.shields.io/badge/docker-ready-2496ED?logo=docker\&logoColor=white)

</div>

---

## Why Flytrap?

Flytrap is a small mail inbox you run yourself. It accepts every recipient on your domains, keeps the raw message, and asks a model to sort the pile. Sorting is a suggestion. A missing address note is not "unknown", and a failed SPF check does not hide a real letter.

- **Keep everything** — SMTP ingest writes the raw EML and the envelope. Any local part on an accepted domain is kept.
- **AI sorting** — Gemini or OpenAI labels each message `legit`, `spam`, `unsolicited-admin`, `phish`, `malware`, or `gray` (shown as 待看: look at this one).
- **Read it** — Three-column inbox, sandboxed HTML preview that never runs scripts, remote images held until you ask, SPF/DKIM/DMARC, and a manual label when the model is wrong.
- **Name it** — The panel, each category, a receiving domain, a sender, and your own addresses can use the words you want. The stored category ids stay put.
- **Optional alerts** — Telegram or webhook only for the labels you list. Ordinary mail stays in the inbox.
- **No extra services** — SQLite and the filesystem. No Postgres, Redis, or Kafka.
- **One command** — `docker compose up -d`.

---

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/wvvu/flytrap.git
cd flytrap
cp .env.example .env

# Edit .env — at minimum set these:
#   API_PASSWORD=<a-strong-password>
#   SESSION_SECRET=<64-char-random-string>
#   ACCEPT_DOMAINS=yourdomain.com

docker compose up -d
```

Open **<http://localhost:8080>** → login with the credentials from `.env`.

To start classifying emails with AI, set `CLASSIFIER=gemini` and provide your API key(s) in `GEMINI_API_KEYS`.

> **Production note**: Flytrap runs as an unprivileged container listening on SMTP port `2525`. On a production Linux VPS, forward standard incoming port 25:
>
> ```bash
> sudo iptables -t nat -A PREROUTING -p tcp --dport 25 -j REDIRECT --to-port 2525
> ```
>
> The panel is bound to `127.0.0.1:8080` for security. Place Caddy or Nginx in front of it for HTTPS.

### Seed test emails

From the host machine (not inside the container):

```bash
npm install   # installs nodemailer (devDependency)
node scripts/seed-mock-emails.mjs
```

This sends 4 sample emails (phishing, GitHub notification, promo spam, payslip) to the local SMTP port.

### Local development

```bash
npm install
cp .env.example .env   # edit as above
npm run dev             # tsx hot-reload on :8080 + :2525
```

---

## Architecture

```
Internet                         Flytrap (single process, 3 roles)
─────────                        ─────────────────────────────────
                                 ┌───────────┐
  MX record ──────── SMTP :2525 ─┤           │
                                 │  SQLite   │ ← WAL mode, zero-config
  Browser ────────── HTTP :8080 ─┤  + disk   │
                                 │           │
                                 └─────┬─────┘
                                       │
                        ┌──────────────┼──────────────┐
                        ▼              ▼              ▼
                   ┌─────────┐   ┌──────────┐   ┌──────────┐
                   │  SMTP   │   │  Worker  │   │   API    │
                   │ ingest  │   │  (jobs)  │   │ + Panel  │
                   └────┬────┘   └────┬─────┘   └──────────┘
                        │             │
                  store raw      auth → parse
                  EML + meta     → classify (AI)
                                 → notify
```

**Pipeline per email:**

1. **SMTP ingest** — Accept, rate-limit, write compressed raw EML
2. **Auth** — SPF, DKIM, DMARC via `mailauth`
3. **Parse** — Extract headers, body, URLs, attachments via `postal-mime`
4. **Classify** — Send to Gemini / OpenAI with configurable system prompt
5. **Notify** — Push phish/malware alerts to Telegram or webhook

---

## Features

| Category     | Feature                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| **SMTP**     | RFC-compliant ingest, STARTTLS, per-IP rate limiting (connections / minute / data-per-hour), multi-domain accept |
| **AI**       | Gemini native API with multi-key pool + auto-cooldown, OpenAI-compatible fallback, prompt edited in the panel    |
| **Security** | Sandboxed HTML preview (iframe CSP), zero-innerHTML frontend, timing-safe auth, path traversal protection        |
| **Ops**      | Dead letter queue with one-click retry, full audit log, graceful shutdown, Docker healthcheck                    |
| **UI**       | Dark/light theme, keyboard shortcuts (j/k/r), the inbox defaults to every message, manual label with an audit trail |

---

## Configuration

All configuration is via environment variables. See [`.env.example`](.env.example) for the full reference.

<details>

<summary><strong>Key variables</strong></summary>

| Variable          | Required    | Default            | Description                                  |
| ----------------- | ----------- | ------------------ | -------------------------------------------- |
| `ACCEPT_DOMAINS`  | ✅           | —                  | Comma-separated domains to accept mail for   |
| `API_PASSWORD`    | ✅           | —                  | Login password for the web panel             |
| `SESSION_SECRET`  | ✅           | —                  | ≥ 32 bytes. Generate with `node -e "..."`    |
| `CLASSIFIER`      | —           | `fake`             | `fake`, `gemini`, or `openai-compat`         |
| `GEMINI_API_KEYS` | when gemini | —                  | Comma-separated Google AI API keys           |
| `GEMINI_MODEL`    | —           | `gemini-2.5-flash` | Model ID                                     |
| `ROLES`           | —           | `smtp,worker,api`  | Which roles this process runs                |
| `SMTP_PORT`       | —           | `2525`             | SMTP listen port                             |
| `API_PORT`        | —           | `8080`             | HTTP listen port                             |
| `NOTIFY_LABELS`   | —           | `phish,malware`    | Which labels trigger push notifications      |
| `COMPRESS`        | —           | `auto`             | `auto` / `zstd` / `gzip` for raw EML storage |

</details>

---

## Tech Stack

- **Runtime** — Node.js 22+ / TypeScript 5.9
- **HTTP** — [Fastify 5](https://fastify.dev) + helmet, CSRF, rate-limit, session
- **Database** — [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (WAL mode)
- **SMTP** — [smtp-server](https://github.com/nodemailer/smtp-server)
- **AI** — Google Gemini REST API (native) / OpenAI-compatible
- **Email parsing** — [postal-mime](https://github.com/nicoleahmed/postal-mime) + [mailauth](https://github.com/postalsys/mailauth)
- **Compression** — zstd (native addon) / gzip fallback
- **Frontend** — Vanilla JS, zero build step, zero framework

---

## Project Structure

```
src/
├── ai/          # Gemini / OpenAI classifiers, prompt management
├── api/         # Fastify routes, auth, static panel serving
│   └── public/  # Single-page frontend (HTML + CSS + JS)
├── db/          # SQLite schema, migrations, repositories
├── ingest/      # Raw EML storage, rebuild pipeline
├── mail/        # SPF/DKIM/DMARC authentication
├── notify/      # Telegram & webhook notifiers
├── smtp/        # SMTP server, rate limiting, policy
├── worker/      # Job queue loop, per-type handlers
├── config.ts    # Env → typed config with Zod validation
└── main.ts      # Entrypoint, role orchestration, graceful shutdown
```

---

## Roadmap

- [ ] Real-time new-email push (SSE / WebSocket)
- [ ] Responsive mobile layout
- [ ] Time-series threat trend charts
- [ ] YARA rule integration for attachment scanning
- [ ] Multi-user RBAC
- [ ] Retention policy & automatic disk cleanup

---

## Operations & Disaster Recovery

- **Run test suite**:
  ```bash
  npm test
  ```
  Runs the full automated test suite (47 unit & integration tests covering SMTP policy, authentication, DLQ, parser, Gemini failover, and prompt injection guardrails).
- **Rebuild database from raw storage**:
  ```bash
  node dist/main.js --rebuild
  ```
  Flytrap treats raw compressed EMLs as the ultimate source of truth. If SQLite is corrupted or accidentally deleted, `--rebuild` scans all raw storage and restores the entire database, automatically re-enqueuing missing jobs.

---

## License

[MIT](LICENSE)

---

<div align="center">   <sub>Named after the <a href="https://en.wikipedia.org/wiki/Venus_flytrap">Venus flytrap</a> — it sits on the domain and keeps the mail.</sub>
</div>
