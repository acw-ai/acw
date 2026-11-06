# Contributing to ACW

Thank you for your interest in contributing to **ACW** (After-Call Work)! 

ACW is building the open-source standard for contact center call dispositions, queue wrap-up enforcement, and voice AI intelligence. We welcome contributions from developers, VoIP engineers, telecom specialists, and contact center operators worldwide.

---

## 🌟 How You Can Help

1. **Star the Repository:** If you find ACW useful, please give us a ⭐️ on GitHub! It helps more developers discover the project.
2. **Add Telephony Adapters:** Help us build native connectors for:
   - **Vicidial**
   - **Kamailio / OpenSIPS**
   - **Kazoo / 2600hz**
   - **Wazo Platform**
   - **SIP / WebRTC Softphones**
3. **CRM Integrations:** Build pre-packaged templates for HubSpot, Salesforce, Zoho, Zendesk, Monday.com, and Odoo.
4. **AI Models:** Enhance transcript processing and multi-language AI call summarization (Whisper + Ollama).

---

## 🛠️ Development Setup

```bash
git clone https://github.com/acw-ai/acw.git
cd acw
cp .env.example .env
npm install
npm run simulate
```

* Visit `http://localhost:3100/sim.html` to generate realistic synthetic PBX calls without needing a live telephone system.
* Visit `http://localhost:3100/agent.html` (Extension `100`, PIN `1234`) to test agent screen-pops.
* Visit `http://localhost:3100/supervisor.html` (Password `admin`) to view real-time metrics.

---

## 📐 Adding a New Telephony Driver

To add a new PBX driver:
1. Create a client module in `src/telephony/<name>.js`.
2. Implement the standard interface:
   - `startEventStream({ onUpsert, onRemove })`
   - `getAgentUser(extension)`
   - `getQueueStatus(extension)`
   - `setQueueStatus(extension, status)`
3. Register your driver in `src/telephony/index.js`.
4. Submit a Pull Request!
