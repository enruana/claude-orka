# HTTPS via Tailscale

Orka serves the dashboard, terminals, and APIs from a single Express server. To access it from another device — your Mac, iPhone, iPad — through Tailscale, you should run it over **HTTPS**. This page explains why and how.

## Why you need HTTPS

The browser's **Clipboard API** (`navigator.clipboard.writeText`) only works in a **secure context**. That means HTTPS, or `localhost`. If you access `http://my-pc.tailnet.ts.net:3456` from another machine, the Clipboard API silently fails, which breaks:

- Auto-copy on text selection in the terminal
- The OSC 52 forwarding chain (tmux → xterm.js → system clipboard)
- The "Tap to Copy" buttons in the mobile terminal
- Any feature inside the Web UI that uses `navigator.clipboard`

Tailscale issues real Let's Encrypt certificates for every node in your tailnet, so you can have HTTPS without configuring DNS or a public domain.

## Prerequisites

1. **Tailscale installed** on the server. `orka prepare` does this on Linux (official install script) and macOS (Homebrew cask).
2. **Logged in**: `sudo tailscale up`.
3. **MagicDNS + HTTPS enabled** in the Tailscale admin: <https://login.tailscale.com/admin/dns>. Toggle on:
   - *Enable MagicDNS*
   - *HTTPS Certificates*

If `orka doctor` shows the `Tailscale (HTTPS)` check as warn/fail, complete the steps above first.

## Generate the cert

Find your Tailscale hostname:

```bash
tailscale status | head -1
# 100.x.y.z   my-pc   me@   linux   -
#               ↑
#       this is the short hostname

tailscale dns status | grep "this device at"
# "Other devices in your tailnet can reach this device at my-pc.<tailnet>.ts.net"
```

Generate the cert into the Orka certs directory:

```bash
sudo tailscale cert my-pc.<tailnet>.ts.net
# Creates two files in the current directory:
#   my-pc.<tailnet>.ts.net.crt
#   my-pc.<tailnet>.ts.net.key

# Move them to Orka's expected location
mkdir -p ~/.orka/certs
sudo mv my-pc.<tailnet>.ts.net.* ~/.orka/certs/
sudo chown $USER:$USER ~/.orka/certs/*
chmod 600 ~/.orka/certs/*.key
```

> **To avoid `sudo` on future cert renewals**, run once: `sudo tailscale set --operator=$USER`. After that, `tailscale cert` works without sudo.

## Start Orka with HTTPS

`orka start` automatically detects any `*.crt` + matching `*.key` pair in `~/.orka/certs/` and starts in HTTPS mode. No flags needed:

```bash
orka start
# → "Auto-detected SSL cert for my-pc.<tailnet>.ts.net"
# → "Running at: https://localhost:3456"
```

From another device on your tailnet:

```
https://my-pc.<tailnet>.ts.net:3456
```

You should see a real green padlock (no cert warning).

## Force HTTP

If you want to skip HTTPS even though certs exist (e.g. for local debugging):

```bash
orka start --http
```

Or pass explicit cert paths to override the auto-detection:

```bash
orka start --cert /path/to/custom.crt --key /path/to/custom.key
```

## Renewal

Tailscale-issued certs are valid for ~90 days. When you regenerate:

```bash
tailscale cert my-pc.<tailnet>.ts.net
mv my-pc.<tailnet>.ts.net.* ~/.orka/certs/
chmod 600 ~/.orka/certs/*.key
```

Then restart `orka start`. (Server doesn't watch the cert files at runtime.)

## Troubleshooting

**`orka doctor` says "No cert found"** — Run the generate step above. If it says "Tailscale not connected", run `sudo tailscale up`.

**Browser shows cert warning** — You're probably hitting `https://localhost:3456` instead of the Tailscale FQDN. The cert is only valid for the FQDN.

**"Mixed content" errors in the console** — All resources are served from the same origin, so this shouldn't happen. If it does, ensure your terminal iframe is loading from a relative `/terminal/...` URL (not an absolute http URL).

**Clipboard still doesn't work even with HTTPS** — Make sure the tmux session has the new config (`set-clipboard on` + `terminal-overrides` for OSC 52). Sessions created before the config change need to be killed and recreated. Use the dashboard's *Sync* button on the project, then create a fresh session.

**Cert in `~/.orka/certs/` but wrong owner** — Re-run `sudo chown $USER:$USER ~/.orka/certs/*` so node can read them.

## What `orka prepare` does for HTTPS

For reference, `orka prepare` automates:

- Installs Tailscale (Linux: official `install.sh`; macOS: `brew install --cask tailscale`)
- Creates `~/.orka/certs/`
- Detects your Tailscale hostname
- Prints the exact `sudo tailscale cert <hostname>` command for you (it can't run sudo non-interactively)

It does **not** run `tailscale up` for you — that's interactive (browser auth) and out of scope.

## Implementation references

- `src/utils/certs.ts` — `CERTS_DIR`, `findCertPair`, `getTailscaleHostname`, `ensureCertsDir`
- `src/cli/commands/start.ts` — Auto-detection logic and `--cert/--key/--http` flags
- `src/cli/commands/prepare.ts` — `installTailscale()` and `setupTailscaleCerts()`
- `src/cli/commands/doctor.ts` — `checkTailscale()` and `checkSSLCerts()`
- `src/server/index.ts` — `https.createServer` when `ServerOptions.certPath/keyPath` are set
