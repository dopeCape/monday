# monday · design lock-in

Static mockups of the desktop client. No build step.

```sh
bun run design        # http://localhost:6969
```

- `index.html` is the hub: every layout, screen and palette as a live preview.
- `app.html` is the mock app. Stream is the default layout. Query params:
  `layout=stream|columns|agent-left` (a preset) or the knobs `nav=full|rail|hidden`,
  `agent=bottom|left|right`, `list=stream|split`;
  `palette=graphite|catppuccin|gruvbox|nord|tokyonight|rosepine|everforest`,
  `theme=light|dark|system`, `density=compact|comfortable|spacious`,
  `open=1` opens the agent, `thread=layout` shows the agent changing the UI,
  `sel=<id>` opens a thread, `overlay=cmdk|compose`, `chrome=0` hides the design toolbar.
- Hash routes: `#/inbox`, `#/inbox/<folder>`, `#/workflows/<id>`, `#/routing`, `#/settings/<section>`.
- Keys: `J`/`K` move, `/` talk to the agent, `C` compose, `⌘K` palette, `Esc` closes, `⌘1`/`⌘2`/`⌘3` switch saved views, `⌘⇧D` flips theme.

Tokens live in `css/tokens.css`. Palettes only redefine tokens, which is the same
contract `~/.config/monday/monday.toml` will use on Linux.

Fonts: Geist + Geist Mono. Icons: Phosphor, regular weight only. The agent is a plain monogram mark, no sparkle glyphs. Vendored in `vendor/`.
