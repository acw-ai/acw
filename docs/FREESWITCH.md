# Connecting ACW to FreeSWITCH / FusionPBX

ACW connects directly to **FreeSWITCH 1.10+** and **FusionPBX** using the **Event Socket Library (ESL)** via `mod_event_socket`.

---

## 1. Verify `mod_event_socket` in FreeSWITCH

Ensure `mod_event_socket` is loaded in `/etc/freeswitch/autoload_configs/modules.conf.xml`:

```xml
<load module="mod_event_socket"/>
```

Check your configuration in `/etc/freeswitch/autoload_configs/event_socket.conf.xml`:

```xml
<configuration name="event_socket.conf" description="Socket Client">
  <settings>
    <param name="nat-map" value="false"/>
    <param name="listen-ip" value="0.0.0.0"/>
    <param name="listen-port" value="8021"/>
    <param name="password" value="ClueCon"/>
    <param name="apply-inbound-acl" value="lan"/>
  </settings>
</configuration>
```

---

## 2. Configure ACW `.env`

```ini
TELEPHONY_DRIVER=freeswitch
FREESWITCH_ESL_HOST=freeswitch-server-ip
FREESWITCH_ESL_PORT=8021
FREESWITCH_ESL_PASSWORD=ClueCon
```

---

## 3. How ACW Interacts with FreeSWITCH

* **Call Tracking:** ACW listens to `CHANNEL_CREATE`, `CHANNEL_ANSWER`, and `CHANNEL_HANGUP_COMPLETE` events over TCP.
* **Wrap-Up Enforcement (`mod_callcenter`):** When an agent call ends, ACW sets the agent status to `'On Break'` via:
  ```
  api callcenter_config agent set status <agent_ext> 'On Break'
  ```
* **Release:** Once the agent submits their disposition outcome, ACW releases the agent back to `'Available'`:
  ```
  api callcenter_config agent set status <agent_ext> 'Available'
  ```
