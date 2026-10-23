# ioBroker.redundancy

![Logo](admin/redundancy.svg)

Redundant SCADA servers for ioBroker. Two (or more) ioBroker hosts share their objects and
states through Redis with Sentinel; when the primary server fails, the standby takes over
in about 1.5 seconds without losing writes, and a planned switchover takes about 1.3
seconds.

## How it works

| Part | Where it runs | What it does |
|---|---|---|
| **Watchdog** (native) | a service of the operating system on every server: systemd (Linux), launchd (macOS), Windows service, or a container | sends signed heartbeats over every link you give it (P2P cable, fiber, LAN, WLAN), holds the primary lease in Redis, forces the Redis failover when the primary is gone, and fences its own server when it is cut off |
| **Adapter** (this package) | ioBroker | shows the role of this server, the master and the peer, and checks that this server's Redis client settings survive a switch |

The watchdog runs outside ioBroker on purpose: it must keep working when js-controller
stops or hangs.

Supported platforms: Linux x64 and arm64 (glibc 2.35 or newer, e.g. Debian 12, Ubuntu 22.04),
Windows x64, macOS arm64 and x64. Only the files of your platform are expanded on first
use.

## Setup (short)

1. Run Redis with Sentinel on both servers and a witness Sentinel on a third machine.
2. Point `iobroker.json` (objects and states) of every host at the Sentinels. The adapter
   checks the client options and logs what is missing, e.g.

   ```json
   "options": { "retry_max_delay": 150, "retry_max_count": 100000, "failoverDetector": false,
                "connectTimeout": 1000, "maxRetriesPerRequest": null, "keepAlive": 1000 }
   ```

   On Linux also set `net.ipv4.tcp_retries2 = 3` (a vanished server sends no TCP reset;
   with the default a Redis command can hang for minutes).
3. Write the watchdog config of the server and install the watchdog once; the state
   `redundancy.0.watchdogInstall` shows the exact command for this host:

   ```
   sudo .../prebuilds/linux-x64/redundancy-watchdog install /etc/scada/watchdog.json
   ```

   `redundancy-watchdog check <config> --iobroker <iobroker.json>` checks the config and
   the host settings before you install.
4. Set the watchdog's status file in the adapter settings.

## States

| State | Meaning |
|---|---|
| `info.connection` | the watchdog of this host is running |
| `role` | `primary`, `standby`, `fenced` or `offline` |
| `primary` | Redis master the cluster runs on |
| `epoch` | lease epoch; rises on every takeover |
| `peer` | the other server as the heartbeat links see it |
| `clientOptions` | Redis client options of this host that a switch needs (empty = right) |
| `engineVersion` | version of the native engine |
| `watchdogInstall` | command that installs the watchdog service on this host |

## Licence

The adapter code is MIT licensed. The native engine files in `prebuilds/` are built from a
closed-source engine and are proprietary.

## Changelog

### 0.0.1

- First build: the native engine for Linux, Windows and macOS (x64, arm64); the adapter
  checks the Redis client options of this host and shows the watchdog's role.
