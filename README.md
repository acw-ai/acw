<div align="center">

# ⚡ ACW (After-Call Work)
### Universal Open-Source After-Call Work, Call Dispositions & Voice AI

**The open-source disposition layer for Asterisk, FreePBX, FreeSWITCH, 3CX, Twilio & VoIP.**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.15-brightgreen.svg)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/docker-ready-blue.svg)](https://www.docker.com)
[![Telephony](https://img.shields.io/badge/Telephony-Asterisk%20%7C%20FreeSWITCH%20%7C%203CX%20%7C%20Webhooks-orange.svg)](#-supported-telephony-platforms)
[![AI Providers](https://img.shields.io/badge/AI-Ollama%20(Local)%20%7C%20OpenAI-purple.svg)](#-pluggable-ai-engine)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

<p align="center">
  <a href="#-quickstart-with-docker">Quickstart (60s)</a> •
  <a href="#-supported-telephony-platforms">PBX Integrations</a> •
  <a href="#-architecture">Architecture</a> •
  <a href="#-features">Features</a> •
  <a href="#-universal-crm-webhooks">CRM Sync</a> •
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

</div>

---

## ⚡ The Problem ACW Solves

In modern contact centers and sales teams, agents spend **15% to 25% of their working day** manually typing call notes, searching through messy CRM drop-downs, or forgetting to log outcomes altogether. Meanwhile:
* Traditional enterprise CCaaS suites (Talkdesk, Genesys, Five9) charge **\$80 to \$150 / agent / month**.
* Standard PBXs (Asterisk, FreeSWITCH, FreePBX, 3CX) provide great audio routing, but lack mandatory wrap-up enforcement, instant agent screen-pops, and automated AI disposition intelligence.

**ACW bridges this gap.** It gives you a sleek, modern, self-hosted contact center intelligence layer that connects to your existing PBX in minutes.

---

## 🚀 Key Features

| Feature | Description |
| :--- | :--- |
| 🛡️ **Mandatory Queue Lockout** | Automatically logs agents out of queues upon call disconnect until an outcome is logged. Zero untracked calls. |
| ⚡ **Instant Agent Screen-Pop** | Lightweight agent PWA & Chrome popup showing customer caller ID, talk timer, and customizable outcome categories. |
| 🤖 **Pluggable Voice AI Engine** | Auto-summarizes calls and suggests dispositions using **100% private local Ollama (Llama 3.2)** or OpenAI. |
| 📊 **Supervisor Command Center** | Real-time agent status radar, active call timers, disposition donut analytics, and one-click CSV data export. |
| 📞 **Multi-PBX Telephony Drivers** | Native connectors for **Asterisk (ARI)**, **FreeSWITCH (ESL)**, **3CX (Call Control API)**, and **Universal HTTP Webhooks**. |
| 🔄 **Universal CRM Webhooks** | Emits clean JSON events to HubSpot, Salesforce, Zoho, Zendesk, Zapier, or n8n workflows on every disposition. |
| 🔒 **100% Self-Hosted & Private** | Zero external telemetry. Customer caller IDs, audio, and call records never leave your servers. |

---

## 🥊 ACW vs Enterprise CCaaS

| Capability | ACW (Open-Source) | Enterprise CCaaS (Five9 / Talkdesk) | Vanilla PBX |
| :--- | :---: | :---: | :---: |
| **Cost** | **Free & Open-Source** | \$100 - \$180 / agent / month | Free / Low-cost |
| **Data Privacy** | **100% On-Premise / Self-Hosted** | Cloud vendor lock-in | On-Premise |
| **Queue Lockout Enforcement** | ✅ Native | ✅ Yes | ❌ No |
| **Local Private AI (Ollama)** | ✅ Built-in | ❌ Proprietary Cloud AI | ❌ No |
| **CRM Webhook Dispatcher** | ✅ Built-in (Zapier/n8n/HubSpot) | ⚠️ Costly add-on licenses | ❌ Manual dialplan scripts |
| **Multi-PBX Support** | ✅ Asterisk, FreeSWITCH, 3CX, VoIP | ❌ Proprietary softswitch only | ⚠️ Single vendor |

---

## 🏗️ Architecture

```
                                 TELEPHONY SOURCES
   ┌───────────────────┬──────────────────────┬──────────────────┬─────────────────┐
   │ Asterisk (ARI)    │ FreeSWITCH (ESL)     │ 3CX (CallControl)│ Universal Hooks │
   └─────────┬─────────┴──────────┬───────────┴────────┬─────────┴────────┬────────┘
             │                    │                    │                  │
             └────────────────────┼────────────────────┴──────────────────┘
                                  ▼
                    ┌───────────────────────────┐
                    │  Unified Telephony Engine │
                    │     (State & Sessions)    │
                    └─────────────┬─────────────┘
                                  │
     ┌────────────────────────────┼───────────────────────────┐
     ▼                            ▼                           ▼
┌───────────────────────┐ ┌───────────────────────┐ ┌──────────────────┐
│  Agent Screen-Pop     │ │ Supervisor Portal     │ │ Outbound Webhook │
│  - Realtime Dispo     │ │ - Live Presence Radar │ │ - CRM & Zapier   │
│  - Queue Hold Release │ │ - Dispo Analytics     │ │ - n8n Automation │
│  - AI Bullet Summary  │ │ - CSV Data Export     │ │ - DB Storage     │
└───────────────────────┘ └───────────────────────┘ └──────────────────┘
```

---

## 🚀 Quickstart with Docker

Test ACW in under 60 seconds with our built-in interactive PBX simulator:

```bash
git clone https://github.com/acw-ai/acw.git
cd acw
cp .env.example .env
docker compose up -d
```

Open your browser:
* 🎛️ **Supervisor Command Center:** `http://localhost:3100/supervisor.html` *(Password: `admin`)*
* 🎧 **Agent Screen-Pop Portal:** `http://localhost:3100/agent.html` *(Agent `100`, PIN `1234`)*
* 🧪 **PBX Call Simulator:** `http://localhost:3100/sim.html` *(Simulate inbound & outbound calls without a live PBX)*

---

## 🔌 Supported Telephony Platforms

ACW connects to your existing telecom stack through dedicated drivers:

* 📖 **[Asterisk & FreePBX Integration Guide](docs/ASTERISK.md)** — Connect via Asterisk REST Interface (ARI) or dialplan `CURL()`.
* 📖 **[FreeSWITCH & FusionPBX Integration Guide](docs/FREESWITCH.md)** — Connect via Event Socket Library (ESL) or Lua hangup hooks.
* 📖 **[Universal Inbound Telephony Webhooks](docs/UNIVERSAL_WEBHOOK.md)** — Push call events from Twilio, Telnyx, Plivo, Vicidial, or custom VoIP switches via simple JSON HTTP POST.
* 📖 **3CX Phone System** — Native OAuth & WebSocket Call Control integration for v18 & v20.

---

## 🤖 Pluggable AI Engine

ACW can automatically summarize customer conversations and suggest the best disposition outcome:

```bash
# In .env:

# Option A: 100% Private Local Ollama (Zero data leaves your server)
AI_PROVIDER=ollama
OLLAMA_URL=http://localhost:11434
AI_MODEL=llama3.2

# Option B: OpenAI
AI_PROVIDER=openai
OPENAI_API_KEY=sk-your-key-here
AI_MODEL=gpt-4o-mini
```

---

## 🔄 Universal CRM Webhooks

Whenever an agent logs an outcome, ACW emits a structured event to your CRM or webhook receiver:

```json
{
  "event": "call.disposition_saved",
  "timestamp": "2026-11-06T20:00:00.000Z",
  "call": {
    "id": 142,
    "extension": "101",
    "agentName": "Jordan Smith",
    "customerNumber": "+15551234567",
    "customerName": "Acme Corp",
    "direction": "inbound",
    "category": "Sales",
    "disposition": "Interested / Follow-up",
    "subDisposition": "Enterprise Plan Demo",
    "notes": "Customer interested in 50-seat team deployment. Scheduled demo for Tuesday.",
    "followUpDate": "2026-11-10",
    "talkSeconds": 245
  }
}
```

Compatible with: **HubSpot**, **Salesforce**, **Zoho**, **Zendesk**, **Pipedrive**, **ActiveCampaign**, **Zapier**, and **n8n**.

---

## 👥 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details on submitting PRs, proposing new PBX adapters, or reporting issues.

---

## 📄 License

ACW is licensed under the **GNU Affero General Public License v3.0 (AGPLv3)**. Free for commercial and community use under open-source terms.

<div align="center">
  <sub>Built with ❤️ by the open-source VoIP and contact center community.</sub>
</div>
