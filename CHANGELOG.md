# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased — 0.1.2

_Not yet published. `npm view dsh-vnc-client version` still reports `0.1.1`,
although `package.json` in this repository is already at `0.1.2`._

### Fixed

- **The settings form and the saved-server rows now render.** The plugin page
  showed an "Adding" heading with nothing under it, and no way to see or reach
  a server that had been saved. The markup was in the source; React never
  received it.

  `jsx(type, props, key)` has no slot for children, so the three calls that
  passed children as trailing arguments lost them silently — no error, an
  empty element. Measured in the browser: the form was 609 wide, 0 tall, with
  0 children, and the server rows were the same, so a saved server would have
  been invisible even though it had been written to disk.

  The build guard existed for exactly this and passed the file anyway: it
  stepped its cursor to each call's closing paren, so every `jsx` call nested
  inside another one was skipped — and all the form and list markup is nested.
  It now steps one character at a time, and distinguishes a key in the third
  argument (legitimate) from an element or list there (a dropped child).

  Verified in the browser: the form is 609×230 with Name, Host, Port and
  Password and a Save button; submitting writes the target and renders the row
  with Test connection, Editing and Delete.

## 0.1.1 — 2026-10-19

- Keep held mouse buttons in a ref, and pin the click sequence in a test, so a
  press-and-hold survives the re-render that a pointer event causes.

## 0.1.0 — 2026-10-19

First public release.

- A VNC client tab for the harness right Sidebar: an RFB client that connects
  to any VNC server over a WebSocket-to-TCP bridge in the Host, with servers
  saved from the plugin's settings page.
- Raw, CopyRect, Hextile, Tight and ZRLE rectangles, plus the DesktopSize,
  ExtendedDesktopSize, LastRect and Cursor pseudo-encodings.
- Keyboard, pointer, wheel and clipboard, both ways.
- Passwords travel over RPC rather than the URL, so they stay out of access
  logs.
