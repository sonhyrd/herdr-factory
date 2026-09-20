# `ssh-fake` — the harness's fake `ssh`

A container has no second host, so the fleet's e2e coverage has always pointed a "remote" machine's
API at a second `serve` through `HERDR_FACTORY_FLEET_ENDPOINTS`. That override is read *before*
`SshForwardTransport` does anything, so those scenarios never enter the transport at all.

This shim is the other half. A fleet machine declared `ssh: true` gets **no** endpoint override, so
the shipped transport really runs: it resolves a ControlPath, picks a free local port, spawns `ssh`
with the production argv, polls `/health` on the forwarded port, caches the forward, re-probes it on
the next read, and tears it down with `ssh -O cancel`. Only the hop is fake — the "forward" is a
loopback TCP proxy onto that machine's own `serve` port.

## Install

`World.writeShims()` copies this file to `<world>/bin/ssh` (already first on PATH) whenever any
fleet machine is `ssh: true`, and writes the config below.

## Config — `$HF_SSH_FORWARDS` (JSON)

```jsonc
{
  "runDir":     "<world>",                 // where proxy pidfiles live
  "spawnLog":   "<artifacts>/ssh-spawns.jsonl",
  "controlLog": "<artifacts>/ssh-control.log",
  "targets": {
    "harness@build-box": {
      "port": 10801,                       // that machine's real `serve` port
      "down": "<world>/ssh-down-build-box" // flag file: present ⇒ the remote is dead
    }
  }
}
```

## Behaviour

| argv | what it does |
|---|---|
| `--hf-proxy <local> <remote> <downFlag>` | the re-exec’d proxy: listens on `<local>` and pipes to `127.0.0.1:<remote>`. While `<downFlag>` exists it refuses new connections **and destroys established ones** — an HTTP client keeps its socket alive between polls, so refusing only new ones would go on answering `/health` after the remote died |
| `-O check …` | logged; exits **0 while the remote is down** (a master that outlived the server behind it — `-O check` only pings the local socket) and 255 otherwise. That is what makes one failing open cost two connect timeouts, which is how the TUI’s polls came to overlap |
| `-O cancel …` | logged; kills the proxy holding the `-L` port |
| `-O exit …` | logged; exits 0 |
| `-N … -L <l>:127.0.0.1:8765 <target>` | logs `start`, then: **up** ⇒ background the proxy and exit 0 (what `ControlPersist` does); **down** ⇒ stay alive, forwarding nothing, until `SIGTERM` (what a real ssh whose forward never answers does) |

## `spawnLog` — JSONL

One `{"ev":"start"|"exit","target","port","pid","t"}` per line. Replaying it gives **how many
forwards were open at once**, which is the `ps` the ssh stampede was originally measured with.
`World.sshForward(name)` does that replay.

## The `down` flag

`w.sshForward("build-box").goDown()` / `.comeUp()`. Present means: the port still binds (the
ControlMaster is alive) and nothing behind it answers — the state a remote's self-update leaves,
and the one a transport that never re-probes can never get out of.

A proxy that has seen the flag is dead **permanently**, even after `comeUp()`: a ControlMaster's
connection dies with the server it was opened over, and only a NEW forward works afterwards.
`comeUp()` therefore only affects forwards opened from then on — which is what makes "the board
came back" mean "the transport re-opened", and not "the harness healed itself".
