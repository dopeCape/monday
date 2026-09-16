# monday · design lock-in

Static mockups of the desktop client. No build step.

```sh
bun run design        # http://localhost:6969
```

- `index.html` is the hub: every layout, screen and palette as a live preview.
- `app.html` is the mock app. Query params: `layout=columns|agent-left|stream`,
  `palette=graphite|catppuccin|gruvbox|nord|tokyonight|rosepine|everforest`,
  `theme=light|dark|system`, `density=comfortable|compact`, `agent=1`,
  `overlay=cmdk|compose`, `chrome=0` hides the design toolbar.
- Hash routes: `#/inbox`, `#/inbox/<folder>`, `#/workflows/<id>`, `#/routing`, `#/settings/<section>`.
- Keys: `J`/`K` move, `/` talk to the agent, `C` compose, `⌘K` palette, `Esc` closes, `⌘⇧D` flips theme.

Tokens live in `css/tokens.css`. Palettes only redefine tokens, which is the same
contract `~/.config/monday/monday.toml` will use on Linux.

Fonts: Geist + Geist Mono. Icons: Phosphor (regular, fill for state). Vendored in `vendor/`.
