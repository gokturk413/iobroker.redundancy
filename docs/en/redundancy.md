# SCADA redundancy for ioBroker — handbook

Version 0.0.1 of `iobroker.redundancy` · [Azərbaycanca](../az/redundancy.md) · [The adapter](adapter.md)

This handbook is for the engineer who sets up two redundant ioBroker servers and for the
operator who runs them.

## 1. What you get

Two ioBroker servers, **A** and **B**, run as one system. One of them is the **primary**
and the other is the **standby**. Both read and write the same objects and states, which are
kept in Redis and copied all the time from the primary to the standby.

| Event | What happens | Measured |
|---|---|---|
| The primary server fails (power, network cable, crash) | the standby becomes primary on its own | ≈ 1.5 s, no write lost |
| A server is cut off from the other one | it stops itself (fences) before the other one takes over, so the system never has two primaries | fence ≈ 0.15 s, takeover ≈ 0.25 s after the last heartbeat |
| A failed server comes back | it joins as standby and copies the data | ≈ 30 s for the copy |
| Planned switch (maintenance) | writes pause, the standby takes over, writes go on | ≈ 1.3 s, no write lost |

There is **no automatic switch back**: after a failover the system stays on the new primary
until you switch it on purpose.

## 2. How it works

```
        ┌──────────── server A ────────────┐        ┌──────────── server B ────────────┐
        │ ioBroker (js-controller, adapters)│        │ ioBroker (js-controller, adapters)│
        │        │ objects + states         │        │        │                          │
        │      Redis (master) ──────────────┼─copy──►│      Redis (replica)              │
        │      Sentinel                     │        │      Sentinel                     │
        │      watchdog ◄───────────────────┼─beats─►│      watchdog                     │
        └───────────────────────────────────┘        └───────────────────────────────────┘
                         ▲                                         ▲
                         └──────────── witness Sentinel ───────────┘
                                   (a third small machine)
```

- **Redis** holds the objects and states. The primary's Redis is the master; the standby's
  Redis is a replica.
- **Sentinel** (one on A, one on B, one on a **witness** machine) tells every client which
  Redis is the master. Clients always ask the Sentinels, so after a switch they find the
  new master by themselves.
- The **watchdog** runs on each server as a service of the operating system, outside
  ioBroker, so it keeps working when ioBroker stops. It:
  - sends a signed heartbeat to the other server 20 times a second over every link you give
    it (P2P cable, fiber, LAN, WLAN);
  - holds the **primary lease** in Redis and renews it;
  - on the standby: when the primary is gone, makes its own Redis the master;
  - on the primary: when it can no longer reach its own Redis, or it hears neither the
    other server nor the witness, **fences** itself (role `fenced`) and runs your fence
    command.
- The **adapter** shows the role of the server and checks its settings (see
  [the adapter](adapter.md)).

### Why a witness

With only two servers, a broken cable between them looks the same to both: "the other one
is gone". The witness is a third opinion. A server that still reaches the witness keeps
running. A primary that reaches neither the other server nor the witness stops. The
witness needs only a Sentinel: a small PC, a VM or a container on another machine.

### The rule that prevents two primaries

The primary fences itself **150 ms** after it lost contact. The standby takes over only
after **250 ms**. The watchdog refuses timings where the takeover is not at least 50 ms
after the fence.

## 3. Requirements

- Two servers with ioBroker (js-controller 6 or newer) and one witness machine.
- Linux x64/arm64 (glibc 2.35 or newer: Debian 12, Ubuntu 22.04 or newer), Windows x64, or
  macOS (Apple silicon or Intel). Docker containers are supported.
- Redis 7 and Redis Sentinel on A, B and the witness.
- At least one network link between A and B; **two independent links** (for example a
  direct cable plus the LAN) are recommended. Each link uses one UDP port (e.g. 7001).
- The clocks of A and B within 2 seconds of each other (NTP).

## 4. Setup, step by step

The example uses A = 192.168.64.11, B = 192.168.64.12, witness = 192.168.64.1.

### 4.1 Redis on A and B

Start Redis on both servers. B starts as a replica of A
(`replicaof 192.168.64.11 6379`). Recommended options:

```
replica-announce-ip <this server's IP>
repl-diskless-load swapdb        # a returning server loads the copy straight into memory
repl-diskless-sync-delay 0       # the master does not wait 5 s before it sends the copy
```

### 4.2 Sentinel on A, B and the witness

The same `sentinel.conf` on all three (only `announce-ip` differs):

```
port 26379
sentinel announce-ip <this machine's IP>
sentinel monitor scada 192.168.64.11 6379 4
sentinel down-after-milliseconds scada 30000
sentinel failover-timeout scada 10000
sentinel parallel-syncs scada 1
```

The quorum is **4 with 3 Sentinels on purpose**: Sentinel never starts a failover by itself;
only the watchdog does. Sentinel is used to find the master. Keep `down-after` at 30000:
shorter values make the failover slower, not faster.

### 4.3 `iobroker.json` on every server

Point `objects` and `states` at the three Sentinels, with these options:

```json
"states": {
  "type": "redis",
  "host": ["192.168.64.11", "192.168.64.12", "192.168.64.1"],
  "port": [26379, 26379, 26379],
  "sentinelName": "scada",
  "options": {
    "retry_max_delay": 150,
    "retry_max_count": 100000,
    "failoverDetector": false,
    "connectTimeout": 1000,
    "maxRetriesPerRequest": null,
    "keepAlive": 1000
  }
}
```

`objects` gets the same. Each option fixes a failure we measured:

| Option | Why |
|---|---|
| `retry_max_delay: 150` | the client reconnects within 150 ms instead of 5 s |
| `retry_max_count: 100000` | the client keeps trying for hours; with the default it gives up after 95 s for good |
| `failoverDetector: false` | when on, it aborts commands during a switch and js-controller restarts all adapters |
| `connectTimeout: 1000` | a dead address costs 1 s instead of 10 s |
| `maxRetriesPerRequest: null` | a command waits for the new master instead of failing after 20 tries |
| `keepAlive: 1000` | a server that vanished sends nothing; without keepalive a waiting connection never notices |

Multihost slaves keep working after a switch: they also ask the Sentinels.

### 4.4 Linux: the TCP setting

```
echo 'net.ipv4.tcp_retries2 = 3' | sudo tee /etc/sysctl.d/90-scada-ha.conf
sudo sysctl --system
```

In Docker give it to the ioBroker container instead (`sysctls: { net.ipv4.tcp_retries2: "3" }`
in the compose file). A server that vanished sends no TCP reset; with the Linux default of
15 a Redis command waits up to 15 minutes. With 3 it gives up after about 3 seconds
(measured: client gap 6.8 s instead of a hang). It applies to every TCP connection of that
host or container.

### 4.5 The watchdog config

One JSON file per server, the same on both except `me` and the link addresses. Example for A:

```json
{
  "cluster": "plant-1",
  "me": "A",
  "keyHex": "<64 hex characters, the same on A and B>",
  "sentinelName": "scada",
  "sentinels": ["192.168.64.11:26379", "192.168.64.12:26379", "192.168.64.1:26379"],
  "witness": "192.168.64.1:26379",
  "hosts": [
    { "name": "A", "priority": 1, "redis": "192.168.64.11:6379" },
    { "name": "B", "priority": 2, "redis": "192.168.64.12:6379" }
  ],
  "links": [
    { "name": "lan",  "medium": "lan", "bind": "192.168.64.11:7001", "peer": "192.168.64.12:7001" },
    { "name": "p2p",  "medium": "p2p", "bind": "10.10.10.1:7001",    "peer": "10.10.10.2:7001" }
  ],
  "statusFile": "/var/lib/scada/watchdog-status.json",
  "logFile": "/var/log/scada/watchdog.log"
}
```

Make the key once and copy it to both servers. **Keep it secret**: anyone with it can send
heartbeats.

```
openssl rand -hex 32
```

| Field | Meaning |
|---|---|
| `cluster` | name of this pair; beats of another cluster are ignored |
| `me` | this server's name, one of `hosts` |
| `keyHex` | heartbeat key, at least 32 bytes in hex |
| `sentinelName` | the name in `sentinel monitor` (default `scada`) |
| `sentinels` | every Sentinel, `ip:port` |
| `witness` | the witness Sentinel (must also be in `sentinels`) |
| `hosts` | every server: `name`, `priority` (1 = preferred), `redis` (`ip:port`) |
| `links` | heartbeat links: `name`, `medium` (`p2p`, `fiber`, `lan`, `wlan`), `bind` (local `ip:port`), `peer` (the other server's `ip:port`), optional `missed` |
| `beatMs` | heartbeat interval, default 50 ms |
| `timing` | optional `{fenceAfterMs, takeoverAfterMs, leaseTtlMs}`, default 150 / 250 / 5000 |
| `witnessRequired` | optional; a primary without the witness and without the peer fences |
| `fenceCommand`, `unfenceCommand` | optional command (as a list, e.g. `["/usr/local/bin/stop-serial.sh"]`) run when this server fences or comes back |
| `statusFile` | the watchdog writes its state here every 250 ms; the adapter reads it |
| `logFile` | log lines (JSON) go here; needed for a Windows service, which has no console |

A link counts as lost after 3 missed beats (WLAN: 10), that is 150 ms at 50 ms beats.

### 4.6 Check, then install the watchdog

The watchdog files come with the adapter (`prebuilds/<platform>/`). The adapter state
`redundancy.0.watchdogInstall` shows the exact path on your server.

```
redundancy-watchdog check /etc/scada/watchdog.json --iobroker /opt/iobroker/iobroker-data/iobroker.json
```

`check` reads the config, the TCP setting (Linux) and the Redis client options and says
`ok`, `warn` or `ERROR` for each. Fix every `ERROR` before you go on.

Install it once as a service of the operating system:

| System | Command | Runs as |
|---|---|---|
| Linux | `sudo redundancy-watchdog install /etc/scada/watchdog.json` | systemd unit `scada-redundancy-watchdog` |
| macOS | `sudo redundancy-watchdog install "/Library/Application Support/SCADA/watchdog.json"` | launchd daemon `com.scada.redundancy-watchdog` |
| Windows | `redundancy-watchdog.exe install C:\ProgramData\SCADA\watchdog.json` (admin shell) | Windows service `scada-redundancy-watchdog` |
| Docker | a container next to Redis with `redundancy-watchdog run /config/watchdog.json` and `network_mode: host` | the container |

The service starts with the machine and restarts one second after a crash. Remove it with
`redundancy-watchdog uninstall`. Keep the watchdog file where it is; after an adapter update
run `install` again so the service uses the new file.

## 5. Before you go live: tests

Do each test once, with ioBroker running and data flowing:

1. **Pull the power or the network of the primary.** The standby must become `primary` in
   about 2 seconds; the adapter of the remaining server shows `role = primary` and a
   higher `epoch`.
2. **Bring it back.** It must come back as `standby`; no switch back happens.
3. **Unplug one heartbeat link only.** Nothing switches; the watchdog log says the
   redundancy is reduced.
4. **Unplug all links between A and B, but keep the witness reachable.** The primary keeps
   running; the standby does not take over.
5. **Cut the primary off from everything.** It must show `fenced` within a second, and the
   standby takes over.

## 6. Daily operation

- **Which server is primary?** `redundancy.0.role` on each server, or `redundancy.0.primary`.
- **Watchdog logs:** `journalctl -u scada-redundancy-watchdog` (Linux),
  `/var/log/scada-redundancy-watchdog.log` (macOS), the `logFile` (Windows and others).
- **A server shows `fenced`:** it cut itself off on purpose. Repair the network; it returns
  as standby by itself.
- **`role = offline`:** the watchdog of that server is not running. Start the service.
- **Updating a server:** update the standby first, then switch, then update the other one.
- **After a power loss Redis does not start** and its log says `Bad file format reading the
  append only file … incr.aof`: a hard stop left the end of the file unwritten, possibly on
  both servers at once. Repair the server that was the master last first, then the other one,
  which then copies the data from it. With Docker, in the stack folder:

  ```
  docker stop scada-redis
  docker run --rm -v ./redis-data:/data --entrypoint sh <redis image> -c \
    'cd /data && cp -a appendonlydir appendonlydir.bak && echo y | redis-check-aof --fix appendonlydir/<the file named in the log>'
  docker start scada-redis
  ```

  Only the writes of the last moment before the power loss are lost; the backup stays in
  `appendonlydir.bak`.

## 7. Not in this version yet

- A switchover button and switch history in the admin (planned switchover is ready in the
  engine and comes with the next adapter version).
- Moving single adapter instances (for example serial or Modbus RTU) to the new primary.
- A virtual IP address.
