# Universal Telephony Webhook API

ACW provides a universal inbound webhook endpoint that allows **any PBX, dialer, softswitch, or cloud VoIP carrier** (Asterisk, FreeSWITCH, Twilio, Telnyx, Plivo, Vicidial, Kamailio, Sipgate) to push live call events directly into ACW.

---

## Endpoint Specification

* **URL:** `POST /api/telephony/events` (or `POST /api/v1/telephony/events`)
* **Content-Type:** `application/json`
* **Authentication (Optional):**
  * `Authorization: Bearer <TELEPHONY_WEBHOOK_TOKEN>`
  * Or header: `X-Telephony-Token: <TELEPHONY_WEBHOOK_TOKEN>`
  * Or query string: `?token=<TELEPHONY_WEBHOOK_TOKEN>`

---

## Supported Lifecycle Events

### 1. Call Started / Ringing
Emitted when an incoming call starts ringing on an agent's phone, or an outbound dial begins.

```json
{
  "event": "call_started",
  "call_id": "call-98765",
  "extension": "101",
  "agent_name": "Jordan Smith",
  "customer_number": "+15551234567",
  "customer_name": "Acme Corp",
  "direction": "inbound"
}
```

* **Effects in ACW:**
  * Opens the live screen-pop for agent `101`.
  * Shows caller identity and initiates live call timer.
  * Shows "Active Call" on the supervisor dashboard.

### 2. Call Answered / Connected
Emitted when the agent picks up the phone.

```json
{
  "event": "call_answered",
  "call_id": "call-98765",
  "extension": "101"
}
```

* **Effects in ACW:**
  * Starts active talk-time tracking.

### 3. Call Ended / Hangup
Emitted when either the customer or the agent disconnects.

```json
{
  "event": "call_ended",
  "call_id": "call-98765",
  "extension": "101"
}
```

* **Effects in ACW:**
  * Stops call timer and calculates total talk time.
  * Marks call as `pending` outcome.
  * **Queue Lockout:** Automatically pauses agent `101` from queues until disposition is saved (if enforcement is enabled).
  * Prompts agent with disposition form & triggers AI call summary.

---

## Integration Examples

### Asterisk Dialplan (`extensions.conf`)
You can notify ACW directly from your Asterisk dialplan using `CURL()`:

```asterisk
[incoming-queue]
exten => 101,1,NoOp(Incoming call to agent 101)
 same => n,Set(CURL_RESULT=${CURL(http://acw-server:3100/api/telephony/events,{"event":"call_started","call_id":"${UNIQUEID}","extension":"101","customer_number":"${CALLERID(num)}"})})
 same => n,Dial(PJSIP/101,30)
 same => n,Hangup()

exten => h,1,NoOp(Call ended)
 same => n,Set(CURL_RESULT=${CURL(http://acw-server:3100/api/telephony/events,{"event":"call_ended","call_id":"${UNIQUEID}","extension":"101"})})
```

### FreeSWITCH Hangup Hook (Lua)
In your FreeSWITCH dialplan or hangup hook:

```lua
-- hangup_hook.lua
local http = require("socket.http")
local ltn12 = require("ltn12")

local call_id = session:getVariable("uuid")
local ext = session:getVariable("dialed_extension") or "101"

local payload = string.format('{"event":"call_ended","call_id":"%s","extension":"%s"}', call_id, ext)
local response = {}

http.request{
    url = "http://acw-server:3100/api/telephony/events",
    method = "POST",
    headers = {
        ["Content-Type"] = "application/json",
        ["Content-Length"] = string.len(payload)
    },
    source = ltn12.source.string(payload),
    sink = ltn12.sink.table(response)
}
```

### Twilio / Telnyx Status Callback
Set the status callback URL in Twilio/Telnyx to:
`http://acw-server:3100/api/telephony/events`

ACW natively understands `CallSid`, `From`, `To`, and `CallStatus` fields!
