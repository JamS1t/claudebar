# claudebar

An always-on, liquid-glass dock on the right edge of your Windows screen that keeps your Claude Code usage in view: session and weekly limits, live sessions, which projects eat the most tokens, suggestions drawn from your own transcripts, and a launcher to resume Claude in any recent project.

## Using it

- **Dock**: a glass tab hugging the right screen edge with two rings (the 5-hour session and the weekly limit), a Projects launcher and a chevron.
- **Hover a ring**: a glass popover slides out with the exact percentage, reset countdown and weekly pace.
- **Chevron**: hover or click to open the details panel with four tabs: Overview, Projects, Insights, Plugins.
- **Projects launcher**: hover or click to open a searchable list of folders you've used Claude Code in. Click a row (or press Enter on the top match) to run `claude --continue` there in Windows Terminal, or a plain console if Windows Terminal isn't installed.
- Hovering another dock control while a panel is open morphs the panel into that control's surface. Moving the pointer away closes it.
- **Drag** the dock up or down the edge (the position is remembered). **Right-click** it to refresh, turn Start at Login on or off, reload the dock, or quit.

The glass is real: the window is excluded from screen capture, so the app streams what is behind it and draws refracting, frosted glass over it with a WebGL shader. Light backdrops switch the glass to dark text.

## Staying light and reliable

The dock is built to sit on screen all day next to heavy work:

- The screen is captured at the blur's own resolution (half the screen size, 30 fps max). While nothing moves and the pointer is away, the glass redraws only 10 times a second, and only the area around the dock is drawn.
- Picking light or dark glass never makes the page wait on a busy GPU.
- Transcripts that grow are read from where the last scan stopped, not from the start, and the cache is only saved when something changed.
- The screen capture restarts by itself after sleep, lock, display changes or a stall. A lost GPU context is rebuilt, and a crashed or hung page is reloaded. Without WebGL the dock falls back to plain dark surfaces instead of going blank.
- Caches are written through a temporary file, so a shutdown mid-write can't corrupt them.

## What the panel shows

- **Overview**: session and weekly utilization with reset countdowns (from the same endpoint `/usage` reads), weekly pace, usage by surface, and live sessions active in the last 15 minutes with their context size (amber above 150k, red above 300k).
- **Projects**: each project's share of weighted usage over 7 days, where tokens go (cache reads, cache writes, output, fresh input), subagent share and most-used tools.
- **Insights**: weekly pacing, oversized sessions, baseline context per fresh session, model mix, tool habits.
- **Plugins**: how much output-trimming plugins (Caveman, Ponytail) can save at most given your output share, plus `rtk gain` totals.

Token weights mirror API price ratios (cache read 0.1x, cache write 1.25x/2x, output 5x). Anthropic doesn't publish plan limits in tokens, so project shares rank projects against each other rather than measure exact cost.

## Requirements

- Windows 10 (2004+) or 11
- Node.js 20+
- Claude Code logged in with a Claude subscription (`~/.claude/.credentials.json`)
- Optional: [rtk](https://github.com/rtk-ai/rtk) on PATH for the RTK savings line
- Optional: [Windows Terminal](https://aka.ms/terminal) for the projects launcher

## Run

```
npm install
npm start
```

The first scan of `~/.claude/projects` takes a few seconds to a minute and runs in a worker thread; later scans only re-read transcripts that changed. Limits refresh every two minutes and back off when rate limited. The scan cache and last known limits live in `%APPDATA%\claudebar`.

Tests (data layer, formatting, springs, plus a scan of your real transcripts if present):

```
npm test
```

Screenshots of every UI state, for visual checks (the live window is invisible to screen capture):

```
npx electron . --snap=shots          # add --white or --split to test light and mixed backdrops
```

### Start at login

Right-click the dock and tick **Start at Login**.

## Legacy version

`sidebar.py` is the original Tkinter dock (`pythonw sidebar.py`, needs Python 3.10+ and Pillow). It is no longer developed.

## Privacy

Everything runs locally. The only network call is to `api.anthropic.com/api/oauth/usage`, made with your own Claude Code OAuth token, which is read from disk at request time and never stored or logged. Transcripts and the screen frames used for the glass effect never leave your machine.

## License

[MIT](LICENSE)
