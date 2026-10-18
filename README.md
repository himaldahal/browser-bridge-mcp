# Browser Bridge MCP

Let any local MCP client drive your own Chromium or Chrome, with no cloud account and no login.
A small Manifest V3 extension talks to a local MCP server over a token-protected loopback WebSocket.
Because it uses your real browser profile, it works on sites where you are already signed in.

```
MCP client  <--stdio-->  server/server.js  <--ws://127.0.0.1:17333-->  extension (service worker)
```

## Features

- **42 tools** for tabs, windows, reading, input, monitoring, SEO checks and human hand-off.
- **Parallel by design.** Commands for different tabs run at the same time, commands for one tab run in order.
  `tabs_open_many` opens dozens of pages at once, `batch` runs many operations in one call, and background tabs
  keep rendering (focus emulation), so a task can work several sites at once.
- **Whole-browser control.** Every window and tab, tab groups, duplicate and move, downloads, JavaScript dialogs,
  popups, shadow DOM and same-origin iframes.
- **Monitoring.** An `events` timeline covers new tabs (with their opener), navigations, loads, closes, dialogs,
  downloads, HTTP errors and CAPTCHAs, plus per-tab console and network capture. Open alerts are attached to
  every tool reply, so nothing is missed mid-task.
- **Human in the loop.** CAPTCHAs are detected and the tab is locked for input; `ask_human` shows a prompt on the
  page and waits for the person. Risky clicks (Post, Send, Submit, Delete, Pay) can require approval.
- **Task tools.** `seo_audit`, `seo_site_check`, `get_links` and `check_links`, `fetch_url`, `fill_form`.
- **Workflow prompts** for SEO audits, brand presence checks, social posting and form filling (see `docs/workflows.md`).
- Real input events through the Chrome debugger API (trusted clicks and keystrokes), so apps that ignore synthetic
  DOM events still work. Several MCP client sessions can share one browser.

## Requirements

- Node.js 18 or newer
- Chromium or Chrome (any Chromium-based browser that supports Manifest V3)

## Install

```bash
git clone https://github.com/himaldahal/browser-bridge-mcp.git
cd browser-bridge-mcp/server && npm install
node server.js --token        # prints your secret token
```

1. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, select the `extension/` folder.
2. Click the extension icon to open settings. Paste the token, tick **Allow remote control of this browser**, Save.
3. Register the server with your MCP client as a stdio server. The command is:

   ```
   node /absolute/path/to/browser-bridge-mcp/server/server.js
   ```

4. Start the client. The extension badge shows **ON** when the bridge is connected.

Optional: set `CBB_PORT` (server environment) and the same port in the extension settings to change the default 17333.

## Tools

| Group | Tools |
| --- | --- |
| Overview | `status`, `events`, `reload_extension` |
| Tabs and windows | `tabs_list`, `windows_list`, `window_create`, `window_close`, `tab_create`, `tabs_open_many`, `tab_duplicate`, `group_tabs`, `tab_close`, `tab_activate`, `navigate`, `resize_window`, `detach` |
| Reading | `read_page` (refs), `get_text`, `get_links`, `screenshot`, `console_logs`, `network_requests`, `wait_for`, `downloads_list` |
| Input | `click`, `hover`, `drag`, `type`, `key`, `scroll`, `form_input`, `fill_form`, `upload_file`, `eval_js`, `handle_dialog` |
| Human in the loop | `detect_captcha`, `ask_human` |
| SEO and web checks | `seo_audit`, `seo_site_check`, `fetch_url`, `check_links` |
| Parallelism | `batch` (runs many tool calls at once) |

Prompts: `seo_audit`, `brand_presence`, `post_to_social`, `fill_form`.

## Security model

This tool gives a program full control of your browser, including tabs you are logged in to. Treat it that way.

- The server binds to `127.0.0.1` only. A random 192-bit token is created at `~/.browser-bridge/token` (mode 600).
- The WebSocket rejects any connection with a web-page `Origin`, so a website cannot talk to it.
- **CAPTCHAs are never automated.** Detection locks the tab: clicks, typing, keys, form fills, uploads and
  `eval_js` are refused until the person solves the challenge and presses Done in the on-page prompt.
- **Approval prompts.** With "Ask me before clicks on buttons like Post, Send, Submit, Delete, Pay" on (default),
  those clicks pause until you press Allow, Allow on this site for 10 min, or Deny. The prompt lives in a closed
  shadow root, accepts only trusted clicks, and automated clicks aimed at it are refused, so neither a page script
  nor the automation itself can approve for you.
- **Blocked sites** (settings, subdomains included) are refused by every tool. Add banks, email and admin panels.
- The master switch cuts access immediately.
- Chrome shows a "started debugging this browser" bar while attached. This is built into the debugger API.
  The extension detaches from tabs idle for 10 minutes.
- `fetch_url` and `check_links` send no cookies.

## Limitations

- Element refs reach same-origin iframes and shadow DOM, not cross-origin iframes (use x,y clicks there).
- Console and network capture start when a tab is first used.
- Snap-packaged Chromium can only read uploads from non-hidden folders under your home directory.
- Browser internal pages (`chrome://`, the web store) cannot be controlled.

## Project layout

```
extension/   Manifest V3 extension (background.js, options page, icons)
server/      MCP server and WebSocket hub (server.js)
docs/        Workflow recipes
```

## License

MIT
