<div align="center">

# ACW (After-Call Work)
### Open-Source Voice & PBX After-Call Work, Dispositions & AI Summarization

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.15-brightgreen.svg)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/docker-ready-blue.svg)](https://www.docker.com)
[![PBX: 3CX](https://img.shields.io/badge/PBX-3CX_v18%20%7C%20v20-orange.svg)](https://www.3cx.com)

**ACW** cuts contact center wrap-up paperwork by up to 70%. It bridges business PBXs (starting with 3CX) with modern agent wrap-up workflows, automatic queue lockouts, AI call summarization, and live supervisor command analytics.

</div>

---

## ⚡ Why ACW?

In traditional call centers, agents spend **15% to 25% of their working hours** manually typing notes, searching through outcome lists, or logging out of queues. Most PBXs either lack mandatory disposition enforcement or require costly enterprise CCaaS licenses ($80–$150/agent/month).

**ACW provides a complete, modern open-source stack:**
1. **Queue Enforcement:** Automatically logs agents out of queues upon call disconnect until an outcome is logged.
2. **Instant Agent Wrap-Up:** Clean PWA / Chrome Extension popup with customer info, talk time, and categorized outcomes.
3. **Live Command Center:** Real-time supervisor portal with active call timers, agent presence, and visual disposition donut analytics.
4. **Universal CRM Webhooks:** Emits structured events to any CRM (HubSpot, Salesforce, Zoho, Zendesk) or Zapier / n8n workflow.
5. **Pluggable AI Engine:** Auto-summarizes transcripts and suggests dispositions using OpenAI or 100% private local Ollama.

---

## 🏗️ Architecture

```
                 ┌────────────────────────────────┐
                 │       3CX Phone System         │
                 │   (Call Control WebSocket API) │
                 └───────────────┬────────────────┘
                                 │
                                 ▼
                     ┌───────────────────────┐
                     │      ACW Server       │
                     │  (Node.js + Webhooks) │
                     └───┬───────────────┬───┘
                         │               │
        ┌────────────────┴──────┐        └────────────────┐
        ▼                       ▼                         ▼
┌───────────────┐       ┌───────────────┐         ┌───────────────┐
│ Agent Popup   │       │ Supervisor    │         │ Universal     │
│ & Extension   │       │ Portal        │         │ Webhook & CRM │
│ (PWA / Chrome)│       │ (Command Ctr) │         │ (Zapier/n8n)  │
└───────────────┘       └───────────────┘         └───────────────┘
```

---

## 🚀 Quickstart with Docker

The fastest way to test ACW locally:

```bash
git clone https://github.com/acw-ai/acw.git
cd acw
cp .env.example .env
docker compose up -d
```

Open your browser:
* **Supervisor Command Center:** `http://localhost:3100/supervisor.html` (Default password: `admin`)
* **Agent Portal:** `http://localhost:3100/agent.html`
* **PBX Call Simulator:** `http://localhost:3100/sim.html` (Test calls without connecting a live PBX)

---

## 💻 Manual Setup

### Prerequisites
* Node.js >= 22.15
* SQLite (default) or MySQL 8.0+

```bash
npm install
npm run simulate   # Starts with built-in call simulator
```

To run against a live 3CX PBX:
1. Configure `PBX_URL`, `PBX_CLIENT_ID`, and `PBX_CLIENT_SECRET` in `.env`.
2. Start the production server:
```bash
npm start
```

---

## 🔌 Universal CRM Integration

ACW supports outbound webhooks on every completed disposition. Configure `WEBHOOK_URL` in `.env`:

```json
{
  "event": "call.disposition_saved",
  "timestamp": "2026-11-06T02:00:00.000Z",
  "data": {
    "callId": 104,
    "extension": "101",
    "agentName": "Alex Smith",
    "customerNumber": "+18005550199",
    "customerName": "Acme Corp",
    "direction": "inbound",
    "category": "Billing",
    "disposition": "Payment Processed",
    "notes": "Paid outstanding invoice via card.",
    "talkSeconds": 142
  }
}
```

---

## 🛡️ License

AGPL-3.0 License.
