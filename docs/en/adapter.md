# The iobroker.redundancy adapter — handbook

Version 0.0.1 · [Azərbaycanca](../az/adapter.md) · [The redundancy system](redundancy.md)

The adapter is the ioBroker side of the redundancy system. It does **not** decide anything:
failover, fencing and the lease are the job of the watchdog service (see
[the redundancy handbook](redundancy.md)). The adapter shows what the watchdog of its server
sees, and checks that the server is set up for a switch.

## 1. Install

Install the adapter on **every** server of the pair (A and B), one instance per server:

```
iobroker add redundancy --host <this server>
```

or in the admin: Adapters → "SCADA redundancy" → add an instance and choose the host.

On first start the adapter expands only the native files of its own platform from
`prebuilds/<platform>/` (Linux x64/arm64, Windows x64, macOS arm64/x64). When the platform
is not supported, the log says so and the instance stops.

## 2. Settings

| Setting | Meaning |
|---|---|
| **Watchdog status file** | `statusFile` of this server's watchdog config, e.g. `/var/lib/scada/watchdog-status.json`. Without it the role stays unknown. |
| **iobroker.json to check** | empty = the `iobroker.json` of this server. Set it only when ioBroker uses another one. |

## 3. States

All states are read-only.

| State | Value |
|---|---|
| `redundancy.0.info.connection` | `true` while the watchdog of this server is running (its status file is not older than 3 s) |
| `redundancy.0.role` | `primary`, `standby`, `fenced` or `offline` (no watchdog) |
| `redundancy.0.primary` | `ip:port` of the Redis master the system runs on |
| `redundancy.0.epoch` | lease number; it rises on every takeover, so a jump tells you a switch happened |
| `redundancy.0.peer` | the other server as the heartbeat links see it: `Ok`, `Degraded` (some links lost), `Isolated` (all links lost, the witness still answers), `Unconfirmed` (no links, no witness), `Lost` |
| `redundancy.0.clientOptions` | JSON list of the Redis client options of this server that a switch needs; `[]` = all right |
| `redundancy.0.engineVersion` | version of the native engine |
| `redundancy.0.watchdogInstall` | the command that installs the watchdog service on this server |

Use `role` and `epoch` in your visualisation or alarms, for example "alarm when `role`
changes" or "alarm when `peer` is not `Ok`".

## 4. The client-option check

At start the adapter reads this server's `iobroker.json` and logs every Redis client option
that would make a switch slow or fatal, for example:

```
error: …/iobroker.json: states.options keepAlive is missing, a switch needs 1000 (…)
```

`error` means the server can stop or lose its database in a switch; `warning` means the
switch takes seconds longer. The right values are in
[the redundancy handbook, 4.3](redundancy.md#43-iobrokerjson-on-every-server). Restart the
instance after you fix the file.

## 5. Installing the watchdog from the adapter

The watchdog must run as a service of the operating system, outside ioBroker. The adapter
cannot install it by itself because that needs administrator rights. Copy the command
from `redundancy.0.watchdogInstall`, put your config path in, and run it once in a root or
administrator shell. After an adapter update, run it again.

## 6. Problems

| You see | Do |
|---|---|
| `role = offline`, `info.connection = false` | the watchdog is not running, or the status file path differs: check the service and the setting |
| `native engine: … not supported` in the log | the platform is not one of the five supported ones |
| `cannot check …/iobroker.json` | set the path in the settings or give the ioBroker user read access |
| `role = fenced` | the server cut itself off on purpose; repair the network, it returns as standby |
| `clientOptions` not `[]` | fix the options listed there (section 4) |
