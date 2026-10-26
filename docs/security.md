# Security model

Browser Bridge gives a program control of a browser that holds your logged-in sessions. This page explains who is
trusted, what protects what, and what is deliberately not protected.

## Who is trusted

| Party | Trust |
| --- | --- |
| The person at the keyboard | Trusted. Only they can approve prompts, resume a pause or change settings. |
| The MCP client and the agent behind it | **Not trusted.** It may be confused or prompt-injected by a web page. |
| Web pages | **Not trusted.** They may try to talk to the bridge or to trick the agent. |
| Other programs on the machine | Trusted only if they can read `~/.browser-bridge/token` (same account). |

## Connection and authentication

- The server listens on `127.0.0.1` only.
- **Mutual HMAC handshake.** The server sends a random nonce, the peer answers with `HMAC-SHA256(token, role|nonce|peer-nonce)`,
  and the server proves it knows the token the same way. The token never crosses the wire, so a rogue process that grabs the
  port first learns nothing, and the extension refuses to talk to it.
- **Origin check.** Web-page origins are refused. Only `chrome-extension://` origins (the extension) and clients with no
  origin (MCP servers) can connect.
- **Host check.** The `Host` header must be the loopback address, which blocks DNS-rebinding attacks.
- **Extension pinning.** The first extension to authenticate is pinned in `~/.browser-bridge/extension-pin.json`. Another
  extension, even one with the token, is refused until you run `node server.js --reset-pin`.
- **Throttling.** Eight failed attempts in a minute lock new connections for a minute.
- The token file and directory are created with mode `600` and `700`, and loosened permissions are tightened at start-up.
  `node server.js --rotate-token` replaces the token.

## What the person controls

- **Pause, Step, Stop** from the popup, the on-page pill or keyboard shortcuts. Pause holds every new command (the agent is told
  to wait). Stop rejects held commands, cancels open prompts, detaches the debugger from every tab and revokes approvals.
- **Permissions** per category: read, navigate, click and type, run scripts. Each is Allow, Ask or Block. Running scripts
  and attaching files default to **Ask**. Prompts show what will run, and whitespace padding cannot hide code.
- **Reach.** "Only tabs the agent opens" keeps the agent away from your own tabs until you share one.
- **Sites.** An optional allow-list and a block-list. `javascript:` and `data:` URLs are never navigated to; `file://` is
  blocked by default.
- **Risky clicks** (Post, Send, Submit, Delete, Pay and more, extendable) need a click from the person.
- **Rate limit** of actions per minute as a brake on loops.
- **Master switch** cuts everything at once.

## Pause and Stop are checked again before every command runs

A command that is already waiting in a tab's queue, or waiting for a prompt, is checked again right before it executes. Pause
holds it, Stop cancels it, and a command whose caller has gone away never runs. The extension also ignores any message that does
not come from a server that completed the handshake.

## Why the agent cannot approve its own prompts

The extension finds its own prompt and pill by holding the page elements it created, not by an `id` the page could change or
fake. They live in closed shadow roots and react only to trusted mouse clicks (`isTrusted` and a non-zero
click count, so keyboard activation does not count). Their buttons are not in the tab order, they sit in the browser's top layer with inline `!important` styles, and the extension re-checks that they are visible while a prompt is open. Clicks and drags are hit-tested in the extension's own world (a page cannot lie about what is under the cursor) and refused
when they would land on a control, and keyboard input is refused while a prompt is open. Messages from pages cannot reach privileged handlers:
the extension checks the sender, and settings and snapshots are available only to its own popup and settings page.

## Commands the caller no longer waits for

When the server stops waiting (a timeout, or the MCP client disconnecting), it tells the extension to cancel the call, so a command
that was held or queued is dropped instead of running later. A Stop also ends a command that is already running at its next step.

## Prompts and approvals

- Approvals are remembered per method and site for ten minutes, never per category, and **Stop** revokes them all.
- Prompts show what will happen: the script, the paths, the URL or the text to type. Text is whitespace-collapsed and any part
  that does not fit is reported as "N more characters not shown".
- Pressing Enter where it would submit a form with a risky button, and pasting the clipboard with Ctrl+V, are treated like a risky click.
- After you approve a click, the extension checks again that the page still has the same target under the pointer, and that the
  tab is still allowed.
- A prompt ignores clicks for its first 600 ms, text is capped and stripped of invisible characters, and a prompt that the page
  hides, moves or covers is shown again. Pages that cannot show a prompt (browser pages, the web store) deny instead of waiting.

## Logging

- The server appends every call to `~/.browser-bridge/audit.log` (mode `600`, rotated at 5 MB).
- The extension keeps the last 500 commands for the popup and settings page.
- Typed text, key presses, form values, dialog replies and file contents are never stored. Scripts are logged as a size and a short
  fingerprint on the server and as a size in the extension.
- Watch it live with `node server.js --follow`, or the live monitor page in the extension.

## Known limits

- This is not a sandbox. With **Allow** on every permission and no blocked sites, an agent can do anything you can do in
  the browser. Use Ask, Reach and the site lists to narrow that.
- The risky-click check reads the button label, so an icon-only button with no label is not caught. Use Ask on
  "Click and type" for sensitive sessions.
- `fetch_url`, `check_links` and `seo_site_check` refuse loopback, private and link-local addresses by default. A redirect to such an
  address is detected and its answer discarded, but the browser has already sent that one request. A hostname that resolves to a
  private address is not caught either, so use the allow-list when that matters.
- A local process running as you can read the token file. Treat the token like an SSH key.
- Chrome shows "started debugging this browser" while the debugger is attached. That is built into the API.

## Reporting a problem

Open an issue without exploit details, or contact the maintainer directly.
