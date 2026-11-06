# Connecting ACW to Asterisk / FreePBX

ACW connects natively to **Asterisk 16, 18, 20, and 21** as well as **FreePBX** using the **Asterisk REST Interface (ARI)** or through the **Universal Telephony Webhook**.

---

## Method 1: Asterisk REST Interface (ARI)

### 1. Enable ARI in Asterisk (`/etc/asterisk/ari.conf`)

```ini
[general]
enabled = yes
pretty = yes
allowed_origins = *

[acw]
type = user
read_only = no
password = your_secure_ari_password
password_format = plain
```

### 2. Enable the Asterisk HTTP Server (`/etc/asterisk/http.conf`)

```ini
[general]
enabled = yes
bindaddr = 0.0.0.0
bindport = 8088
```

### 3. Configure ACW `.env`

```ini
TELEPHONY_DRIVER=asterisk
ASTERISK_ARI_URL=http://asterisk-server:8088
ASTERISK_ARI_USER=acw
ASTERISK_ARI_PASSWORD=your_secure_ari_password
ASTERISK_APP_NAME=acw
```

### 4. Send Calls to the ACW Stasis App in `extensions.conf`

```asterisk
[from-internal]
exten => _1XX,1,NoOp(Route call to agent with ACW tracking)
 same => n,Stasis(acw)
 same => n,Dial(PJSIP/${EXTEN},30)
 same => n,Hangup()
```

When an agent disconnects, ACW catches the `StasisEnd` / `ChannelHangupRequest` event, pauses the agent in the queue using `QueuePause`, and prompts the agent for disposition!

---

## Method 2: Dialplan Webhooks (No ARI Required)

If you prefer not to enable ARI, you can push events from Asterisk dialplans using `CURL()` directly to ACW's webhook endpoint:
See [Universal Telephony Webhook Guide](./UNIVERSAL_WEBHOOK.md).
