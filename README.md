# snappcrawl

**Crawl your iOS app, map every screen, and catch what a change broke: for you, your coding agent and your CI.**

snappcrawl drives the iOS Simulator or a real iPhone, taps through your app on its own (no test scripts) and saves every screen it reaches. Then it compares two builds screen by screen: pixels, texts, buttons, navigation, crashes. One command compares your working tree with `main`:

```bash
snappcrawl check --build --base-ref main
```

![main, your change, pixel diff](docs/compare.png)

```
changes · 11 screens · 10 same · 1 changed · 0 new · 0 broken
s000  Hallo, Lena  changed  new text "Auswertung" · gone "Statistik"
                            renamed "Statistik" → "Auswertung" · same place · leads to the same screen
```

## Install

| For | |
|---|---|
| **Terminal** | `npm i -g github:mace90/snappcrawl`, then `snappcrawl` (checks the setup, opens the web UI) |
| **Claude Code** | `/plugin marketplace add mace90/snappcrawl` and `/plugin install snappcrawl@snappcrawl`: MCP tools plus a skill that checks the app after UI changes |
| **Codex** | `codex mcp add snappcrawl -- snappcrawl mcp` |
| **Cursor, VS Code, Windsurf …** | MCP server `snappcrawl mcp` (stdio); `snappcrawl init --agents` writes the configs for a repository |
| **Every agent in a repository** | `snappcrawl init --agents` (AGENTS.md, CLAUDE.md, Copilot instructions, `.mcp.json`, `.vscode/mcp.json`, `.cursor/mcp.json`) |
| **GitHub Actions** | `uses: mace90/snappcrawl@main`: builds base and pull request, compares, comments ([below](#github-actions)) |

Needs macOS with Xcode and Node 20+; for simulators idb (`snappcrawl setup` walks you through what is missing).

`snappcrawl` checks your setup and opens the web UI. Everything else works from there: devices, WebDriverAgent for iPhones, crawls, review, reports and settings.

```
  ███─┌─┐   ███████╗███╗   ██╗ █████╗ ██████╗ ██████╗  ██████╗██████╗  █████╗ ██╗    ██╗██╗
  ███ └┬┘   ██╔════╝████╗  ██║██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔══██╗██╔══██╗██║    ██║██║
       │    ███████╗██╔██╗ ██║███████║██████╔╝██████╔╝██║     ██████╔╝███████║██║ █╗ ██║██║
      ┌┴┐   ╚════██║██║╚██╗██║██╔══██║██╔═══╝ ██╔═══╝ ██║     ██╔══██╗██╔══██║██║███╗██║██║
      └─┘   ███████║██║ ╚████║██║  ██║██║     ██║     ╚██████╗██║  ██║██║  ██║╚███╔███╔╝███████╗
            ╚══════╝╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝     ╚═╝      ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚══════╝
  v0.4.0 · crawl your app, map every screen, diff builds

  system
  ✓ node            22.11.0
  ✓ xcode           Xcode 26.2 · simctl · license ok
  ✓ idb             idb · idb_companion
  devices
  ✓ simulator       iPhone 17 · iOS 26.2 · booted
  ✓ iphone          Lena's iPhone · usb · unlocked
  iphone
  ✓ trust           paired with this Mac
  ✓ developer mode  on
  ✓ unlocked        unlocked
  ✗ webdriveragent  not set up   snappcrawl wda setup
  optional
  ○ ai notes        off
  ○ config          defaults · snappcrawl init writes a config file

  → snappcrawl setup fixes this step by step

  ui  → http://localhost:4747  (ctrl-c to stop)
```

Narrower than 100 columns the banner is one line (`■ snappcrawl v0.4.0`); without a terminal, with `NO_COLOR` or in CI there is none.

- **No test scripts.** The crawler finds screens itself through the accessibility tree.
- **Simulator or iPhone.** Simulators through idb, iPhones over USB through WebDriverAgent, which snappcrawl builds, starts and stops for you.
- **Logins handled.** Username and password, TOTP codes generated automatically, SMS or e-mail codes typed in when asked, or log in by hand and let it continue.
- **Review as a graph.** Live crawl, screen graph, side-by-side and pixel diff, approve or reject each change, export a report.
- **UI and CLI do the same.** Every action exists in both (table below), so it also runs in CI or over SSH.
- **Built for coding agents.** An MCP server for Claude Code, Codex, Copilot and Cursor, `snappcrawl check --json` with exit codes, changes described in words (texts that came and went, buttons renamed or moved), and `snappcrawl init --agents` so every agent in a repository knows when to check. See [With coding agents](#with-coding-agents).
- **Optional model notes.** Bring your own Anthropic, OpenAI or Ollama model to describe changes. The pixel diff decides; the model only comments.

---

## Requirements

| | Version | Why |
|---|---|---|
| macOS | 14 or newer | the iOS Simulator only runs on macOS |
| Xcode | 16 or newer, with an iOS Simulator runtime | `xcrun simctl` boots simulators and takes screenshots |
| Node.js | 20 or newer | runs snappcrawl |
| idb | latest | reads the accessibility tree and taps ([facebook/idb](https://github.com/facebook/idb)) |
| Python 3 + pipx | any recent | installs the idb client |

Install the tools once:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept
brew tap facebook/fb
brew trust facebook/fb            # newer Homebrew asks you to trust third-party taps
brew install idb-companion        # idb server
brew install pipx && pipx ensurepath
pipx install fb-idb               # idb client (open a new terminal afterwards)
```

## Install

```bash
npm i -g github:mace90/snappcrawl
snappcrawl setup      # optional: fixes whatever the checklist marks, one step at a time
snappcrawl            # opens the web UI
```

`snappcrawl setup` explains each missing piece and runs the fix after you say yes. Commands that need `sudo` are only shown, you run them yourself; steps on the iPhone or in Xcode are described and confirmed with enter. `snappcrawl doctor` prints the same checklist without asking anything.

Or from a clone:

```bash
git clone https://github.com/mace90/snappcrawl && cd snappcrawl
npm install && npm link
```

## Try it without a simulator

```bash
snappcrawl demo     # writes two sample runs of a fictional app to ./.snappcrawl
snappcrawl          # opens http://localhost:4747
```

## Quick start

```bash
snappcrawl devices                                       # pick a simulator name from this list
xcrun simctl boot "iPhone 17"
open "$(xcode-select -p)/Applications/Simulator.app"    # optional: watch it tap
# install your build: Run in Xcode on that simulator, or xcrun simctl install booted MyApp.app

cd my-app-repo
snappcrawl init                     # writes snappcrawl.config.json
snappcrawl apps                     # find your bundle id
snappcrawl crawl --bundle com.acme.app --label v2.3.0    # first run of an app becomes its baseline

# … install the next build …
snappcrawl crawl --bundle com.acme.app --label v2.4.0 --diff
snappcrawl ui
```

## With coding agents

An agent that changes an iOS app can prove its change: crawl the app, compare every screen with the state before, fix what broke. snappcrawl gives it the means and tells it when.

```bash
cd my-app-repo
snappcrawl init --agents --bundle com.acme.app
```

This writes a short *UI checks with snappcrawl* section to `AGENTS.md` (read by Codex, Copilot, Cursor, Gemini, Jules …), imports it in `CLAUDE.md` (Claude Code) and `.github/copilot-instructions.md`, and registers the MCP server in `.mcp.json` (Claude Code), `.vscode/mcp.json` (VS Code with Copilot) and `.cursor/mcp.json`. Existing files keep their content; running it again changes nothing. Commit them, so every agent and colleague gets them. For agents that keep MCP servers per machine:

```bash
codex mcp add snappcrawl -- snappcrawl mcp
claude mcp add --scope user snappcrawl -- snappcrawl mcp
```

**MCP tools** (`snappcrawl mcp`, stdio, no SDK):

| Tool | |
|---|---|
| `status` | setup ready? booted simulators, baselines per app, latest runs |
| `list_apps` · `install_app` | installed apps; install a `.app` built with `xcodebuild -sdk iphonesimulator` |
| `check` · `check_status` · `stop` | crawl and compare with the baseline; `build: true` builds the Xcode project first, `baseRef: "main"` also builds and crawls main as the baseline. Answers within `wait` seconds (default 45), else with a job id to wait on, because some clients end a tool call after 60 s. The first check of an app saves its baseline. |
| `compare` | the comparison of any two runs |
| `screen` | one screen: path, texts and buttons that changed, and the head, base and diff pictures as images |
| `review` · `set_baseline` · `ignore` | approve or reject changes, make a run the reference, leave an animation out |

**The result** (MCP, `check --json`, `diff --json`) says in words what changed, so an agent rarely needs the pictures:

```json
{
  "verdict": "changes",
  "app": "com.acme.app",
  "counts": { "screens": 24, "same": 22, "changed": 1, "new": 1, "broken": 0 },
  "screens": [{
    "id": "s001", "name": "Home", "status": "changed", "decision": "open",
    "path": ["start", "Los geht’s"], "pixelsChanged": "1.20 %",
    "texts": { "added": ["Mein Profil"], "removed": ["Profil"] },
    "buttons": ["renamed \"Profil\" → \"Mein Profil\" · same place · leads to the same screen"],
    "images": { "base": "…/s001.png", "head": "…/s001.png", "diff": "…/s001.png" }
  }],
  "next": ["Look at each open change …", "snappcrawl review <id|all> approve …"]
}
```

| verdict | exit code | meaning |
|---|---|---|
| `passed` | 0 | nothing open: every screen as in the baseline, or all changes approved |
| `baseline` | 0 | first run of the app, saved as its baseline |
| `broken` | 1 | a new crash or a screen that can no longer be reached (a crash the baseline had too is listed as `known`) |
| `failed` | 1 | a change was rejected |
| `changes` | 2 | changed or new screens wait for a decision |
| `input` | 3 | a login, a code or a PIN is needed: set `SNAPPCRAWL_USERNAME`, `SNAPPCRAWL_PASSWORD`, `SNAPPCRAWL_TOTP_SECRET`, `SNAPPCRAWL_PIN` |
| `error` | 4 | setup problem (no simulator, app not installed …) |

`check` uses the limits of the baseline unless given, so no baseline screen is out of reach; screens a run did not get to because of its own limit count as *not reached*, not as broken. A screen whose texts or buttons changed counts as changed even with the same pixels (an accessibility label, for example). Without a terminal, with `CI` set, `--json` or `--no-input` snappcrawl never waits for a person. `snappcrawl diff --markdown` prints the result for a pull request comment.

## Build from Xcode, compare with main

In the app's folder snappcrawl builds the app itself, for the Simulator, and installs it:

```bash
snappcrawl check --build                       # build, install, crawl, compare with the baseline
snappcrawl check --build --base-ref main       # build main too, crawl it first as the baseline, then your working tree
```

`--base-ref` takes any git ref (a branch, a tag, a commit). It is checked out into a temporary worktree, so your working tree stays as it is; both builds have their own derived data under `.snappcrawl/`. That is the whole regression check for a change, with no baseline to keep around. Options: `--project <.xcodeproj|.xcworkspace>` when the folder has several, `--scheme`, `--configuration`, `--set KEY=VALUE` for build settings (repeatable). The bundle id comes from the build.

The repository has a small SwiftUI app to try it: [`examples/ios-demo`](examples/ios-demo). `--set OTHER_SWIFT_FLAGS=-DVARIANT_B` builds a variant with a renamed button and an extra row:

```bash
cd examples/ios-demo
snappcrawl check --build                                          # baseline
snappcrawl check --build --set OTHER_SWIFT_FLAGS=-DVARIANT_B      # → changes: "Profil" → "Mein Profil", new "Yoga"
```

## GitHub Actions

On every pull request: build the base and the change, crawl both, compare, comment the result, fail on a new crash or an unreachable screen.

```yaml
# .github/workflows/snappcrawl.yml
name: snappcrawl
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  ui:
    runs-on: macos-26
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: mace90/snappcrawl@main
        with:
          working-directory: .          # where the .xcodeproj / .xcworkspace is
          fail-on: broken               # broken | changes | never
```

The action installs idb and snappcrawl, boots the newest iPhone simulator, runs `snappcrawl check --build --base-ref <the pull request's base>`, writes the result to the job summary, keeps one pull request comment up to date, uploads the full HTML report, the JSON result and a JUnit file as an artifact, and sets the output `verdict`. Inputs: `project`, `scheme`, `configuration`, `build-settings`, `base-ref`, `simulator`, `max-screens`, `max-depth`, `minutes`, `fail-on`, `comment`. This repository runs it on the demo app in [`.github/workflows/demo.yml`](.github/workflows/demo.yml).

Other CI: `snappcrawl check --build --base-ref origin/main --json --junit snappcrawl.xml` on a Mac with Xcode; the exit code says passed (0), broken (1) or changes (2), and every CI reads the JUnit file.

## Real iPhone over USB

snappcrawl can crawl a real iPhone instead of the simulator. It talks to the phone through [WebDriverAgent](https://github.com/appium/WebDriverAgent) (WDA), a small test runner from the Appium project that snappcrawl builds and installs for you.

### Prerequisites (once)

1. **Apple ID in Xcode.** Xcode → Settings → Accounts → **+** → Apple ID. A free Apple ID works; a paid developer account avoids the 7-day limit below.
2. **Connect and trust.** Plug the iPhone in by USB, unlock it and tap **Trust** on "Trust This Computer?".
3. **Developer Mode.** On the iPhone: Settings → Privacy & Security → **Developer Mode** → on, restart, confirm. (The switch only appears after the iPhone was connected to Xcode once; open Xcode → Window → Devices and Simulators if it is missing.)
4. **Your team id** (10 characters, e.g. `AB12CD34EF`): Xcode → Settings → Accounts → your Apple ID → team, or developer.apple.com/account → Membership details. `snappcrawl wda setup` without `--team` reads it from your signing certificate when there is only one.

### Run it

In the web UI: **Setup** → select the iPhone (marked `usb`). The panel shows connection, trust, lock, Developer Mode and WebDriverAgent. **Set up WebDriverAgent** (team id filled in when it can be read from your certificate) builds it once with live progress; **Start crawl** starts WebDriverAgent by itself when it is not running. Problems on the iPhone (locked, certificate not trusted, Developer Mode off) appear as a hint with what to do.

The same in the terminal:

```bash
snappcrawl doctor                                 # checks devicectl, the iPhone, Developer Mode, WDA
snappcrawl devices                                # simulators and USB iPhones (type column)

snappcrawl wda setup --team AB12CD34EF            # download + build WDA (once, ~2 min)
snappcrawl wda start                              # optional: crawl starts it when needed
snappcrawl apps --device "Lena's iPhone"          # bundle ids on the phone
snappcrawl crawl --device "Lena's iPhone" --bundle com.acme.app --label v2.4.0
snappcrawl wda stop                               # when you are done
```

The first `wda start` with a **free Apple ID** stops with "Untrusted Developer". On the iPhone open Settings → General → **VPN & Device Management** → your Apple ID → **Trust**, then run `snappcrawl wda start` again.

To make the iPhone the default, set `"device": { "platform": "ios-device", "udid": "Lena's iPhone" }` in `snappcrawl.config.json`. `--udid` always means a simulator, `--device` a real iPhone. In the web UI, USB iPhones appear in the device list marked `usb`; if WDA is not running the UI shows the command to start it.

How it fits together: `devicectl` (part of Xcode) finds the iPhone and lists its apps. `wda setup` clones the newest WDA release to `~/.snappcrawl/wda`, gives it your team and a unique bundle id (`com.<you>.snappcrawl.<team>.WebDriverAgentRunner`, change it with `--bundle-id`) and runs `xcodebuild build-for-testing`. `wda start` runs `xcodebuild test-without-building` in the background and forwards `127.0.0.1:8100` to port 8100 on the phone through usbmuxd, the same mechanism `iproxy` uses, built in, so libimobiledevice is not needed. Process ids go to `~/.snappcrawl/wda/pids`, logs to `~/.snappcrawl/wda/*.log`. Another WDA address can be set with `device.wdaUrl`.

Screenshots from real devices are in device pixels (2x or 3x); the status bar height is measured through WDA and masked in diffs at the right pixel size.

### Troubleshooting the iPhone

- **`No iPhone connected`**: unlock the phone, tap Trust, try another cable or port. `xcrun devicectl list devices` should list it.
- **`Developer Mode disabled`**: see prerequisite 3.
- **`Untrusted Developer` / `invalid code signature`**: Settings → General → VPN & Device Management → Trust (free Apple IDs, after every new setup).
- **Stops working after a week**: provisioning profiles of free Apple IDs expire after **7 days**. Run `snappcrawl wda setup` again.
- **`Failed to register bundle identifier`**: the id is taken. `snappcrawl wda setup --team … --bundle-id com.<you>.<anything>.WebDriverAgentRunner`.
- **`maximum number of apps`**: free Apple IDs may register only a few app ids per week; keep the bundle id that is already in `~/.snappcrawl/wda/setup.json`.
- **`WebDriverAgent not reachable at http://127.0.0.1:8100`**: `snappcrawl wda status`, then `snappcrawl wda start`. Keep the iPhone unlocked while WDA starts and while it crawls; auto-lock interrupts the session (Settings → Display & Brightness → Auto-Lock → Never helps).
- **Xcode is "preparing" the iPhone**: the first connection copies debug symbols; wait until Xcode → Window → Devices and Simulators is done.
- The full xcodebuild output is in `~/.snappcrawl/wda/build.log` (setup) and `~/.snappcrawl/wda/xcodebuild.log` (start).

## Using the web UI

`snappcrawl ui` opens the same workflow in the browser:

1. **Setup** – pick a simulator (boot it with a click) or an iPhone (status, WebDriverAgent setup, start and stop), pick an app, add a login if needed, set limits, permission prompts, dismiss labels and the blocklist for this run, start. The footer shows the equivalent CLI command and whether this run becomes the app's baseline.
2. **Run** – the graph grows live, with the latest screenshot, the log and an estimate of progress and time left (taps tried of taps found so far, bounded by the screen and time limits, so it adjusts while new screens appear; the terminal shows the same in its status line). When the crawl needs a 2FA code, a manual login or the `--prepare` pause, **Continue** is here. Afterwards every previous run is listed per app and can be opened or deleted (confirmed in the page).
3. **Compare** – the newest run of an app against its baseline. Filter by status, open a screen to see base, head and pixel diff, approve or reject, add model notes, export a report, or make the new run the baseline.
4. **Settings** – AI provider, model and API key (stored only in `~/.snappcrawl/config.json`, mode 600, shown masked) and the system checklist.

Every app has its own baseline, so runs of different apps are never compared with each other.

When every change is decided, the inspector shows **All changes reviewed** with both export buttons. **Export** in the Compare header works at any time.

## UI ↔ CLI

Every action has a place in the web UI, a CLI command and an API route, all calling the same code in `src/` (the list lives in `src/actions.js`; a test keeps the three in step):

| Action | Web UI | CLI | API |
|---|---|---|---|
| Check the setup | Settings → System | `snappcrawl doctor` | `GET /api/doctor` |
| List simulators and iPhones | Setup → Device · Refresh | `snappcrawl devices` | `GET /api/devices` |
| Boot a simulator | Setup → Device · Boot | `snappcrawl boot <simulator>` | `POST /api/boot` |
| Set up WebDriverAgent | Setup → iPhone · Set up WebDriverAgent | `snappcrawl wda setup` | `POST /api/wda/setup` |
| Start WebDriverAgent | Setup → iPhone · Start | `snappcrawl wda start` | `POST /api/wda/start` |
| Stop WebDriverAgent | Setup → iPhone · Stop | `snappcrawl wda stop` | `POST /api/wda/stop` |
| WebDriverAgent status | Setup → iPhone · status line | `snappcrawl wda status` | `GET /api/wda/status` |
| List installed apps | Setup → App · installed apps | `snappcrawl apps` | `GET /api/apps` |
| Crawl with all options | Setup → Start crawl | `snappcrawl crawl` | `POST /api/crawl` |
| Crawl a baseline build, then a second build against it | Setup → App · then crawl | `snappcrawl crawl --then <bundle>` | `POST /api/crawl` (`then`) |
| … both at once on two simulators | Setup → App · the second build runs | `snappcrawl crawl --then <bundle> --parallel <simulator>` | `POST /api/crawl` (`then`, `parallel`) |
| Continue after Prepare, a login or a code | Run → Continue | `snappcrawl crawl --prepare` | `POST /api/answer` |
| Stop a running crawl | Run → Stop | `snappcrawl crawl` | `POST /api/stop` |
| List runs | Run → runs | `snappcrawl runs` | `GET /api/runs` |
| Delete a run | Run → runs · Delete | `snappcrawl runs rm <run>` | `POST /api/runs/delete` |
| Make a run the baseline | Run → Make baseline · Compare → Make head the baseline | `snappcrawl baseline <run>` | `POST /api/baseline` |
| Compare two runs | Compare | `snappcrawl diff` | `GET /api/report` |
| Approve, reject, undo | Compare → Approve / Reject / Undo | `snappcrawl review <id\|all> <approve\|reject\|undo>` | `POST /api/review` |
| Export a report (summary or full) | Compare → Export | `snappcrawl report` | `GET /api/export` |
| Model notes for changes | Compare → Notes | `snappcrawl notes` | `POST /api/notes` |
| Leave a screen or an area out of the pixel comparison | Compare → Ignore an area / Ignore the screen | `snappcrawl ignore <screen>` | `POST /api/ignore` |
| Compare an ignored area again | Compare → ignored · Remove | `snappcrawl ignore rm <n>` | `POST /api/ignore/remove` |
| Settings (AI provider, model, key) | Settings → AI | `snappcrawl config set <key> <value>` | `POST /api/config` |

Without arguments, `diff`, `review` and `report` (and the Compare tab) take the app of the newest run and compare its baseline with the newest run of that app created after the baseline. If nothing is newer than the baseline, they stop with `<App>: nothing newer than the baseline <label>` instead of comparing an older run. Pass `[base] [head]` run ids to compare any two runs, in either direction. Decisions are stored in the diff's `report.json`, so the UI and the CLI see the same review.

A complete pass, from the baseline to the report:

```bash
# build 1 · becomes the baseline of com.acme.app
snappcrawl crawl --bundle com.acme.app --label v2.3.0

# … install build 2 …
snappcrawl crawl --bundle com.acme.app --label v2.4.0 --diff

snappcrawl review                       # changes and their decisions
snappcrawl review s002 approve          # one screen
snappcrawl review x007 reject           # the crash is a bug
snappcrawl review all approve           # everything still open
snappcrawl review x007 undo             # take a decision back

snappcrawl report                       # .snappcrawl/reports/snappcrawl-acme-v2.4.0-summary.html
snappcrawl report --full --out build/snappcrawl.html

snappcrawl baseline 20261126-091500-v2.4.0   # optional: v2.4.0 is the new reference
```

`review all approve` and `review all reject` only touch screens that are still open; earlier decisions stay. `review all undo` clears every decision.

### Two builds side by side

Often both builds are installed at the same time, each under its own bundle id (for example `com.acme.app` from the App Store build and `com.acme.app.beta` from your branch). Then one command does it all:

```bash
snappcrawl crawl --bundle com.acme.app --then com.acme.app.beta --label 2.4.0
```

1. `com.acme.app` is crawled and becomes its baseline (run `…-2.4.0-baseline`).
2. `com.acme.app.beta` is crawled **against** it (run `…-2.4.0-test`). It [follows the baseline](#comparable-runs-following-the-baseline) and takes over its intro mode, as if it were the same app.
3. The two are compared and the result is printed, as with `--diff`.

The test build gets no baseline of its own. `diff`, `review`, `report` and the Compare tab without arguments then compare exactly these two runs. A single run of the second build against the first build's baseline: `snappcrawl crawl --bundle com.acme.app.beta --against com.acme.app` (`crawl.against`). In the web UI: **Setup → App → then crawl**, or *compare with the baseline of another app*.

The crawl options apply to both runs. `--reinstall` installs one build and does not go with `--then`; use `--intro fresh`, which resets each app before its run.

**Both at once.** With a second simulator the two builds are crawled at the same time, which takes about half as long:

```bash
snappcrawl crawl --bundle com.acme.app --udid "iPhone 17" --then com.acme.app.beta --parallel "iPhone 17 Pro"
```

The test build has to be installed on the second simulator (it is booted if needed). The price: it cannot [follow the baseline](#comparable-runs-following-the-baseline), which is only being made, so its screens are matched afterwards like in any comparison (by path, structure and similarity). For the most exact comparison, leave out `--parallel`. In the web UI: **Setup → App → the second build runs → at the same time on …**. The log marks the lines of the two crawls with `1 │` and `2 │`.

## Comparable runs: following the baseline

Two crawls of the same app rarely click through it the same way on their own. An animation that is not finished, a sheet that is still half open or a list that loaded a moment later is enough. One tap then lands on another view, that view takes a place in the screen limit, and everything after it shifts: a few screens turn up as *new*, others as *unreachable*, though nothing changed.

So a run with a baseline for its app **repeats the baseline first**:

1. **Same screens, same order.** The baseline's screens are visited in the order the baseline explored them (`meta.order`). On each one, its actions come in the baseline's order. Actions the baseline did not have come after them.
2. **Same destination.** When a tap leads somewhere other than in the baseline, the app is started fresh, the path is replayed and the tap is tried once more. The log shows `led elsewhere than in the baseline ("Profil") · once more after a fresh start`. Only when the retry also lands elsewhere is the screen kept as it is, as a real difference. A screen that is recognisably the expected one with changes (a new button, other texts; similarity from 0.6) needs no retry.
3. **The baseline's screens always count.** At the screen limit the run still finishes the baseline's screens, along the baseline's taps. The limit applies to what is new; new screens past it are counted in the log, not kept.
4. **Exploration after that.** Once the baseline is repeated, the rest is explored as usual (see [Crawl order](#crawl-order)).

Every screen stores which baseline screen it is (`base` in `atlas.json`), and `diff` matches by that first. At the end the log says `baseline followed · 12 of 12 screens found again`.

### Label and place: renamed and moved buttons

Every action is stored with its label **and its place** on the screen (the centre of what was tapped). A button of the new run is paired with one of the baseline in this order: the same accessibility id, the same label, then the same place and type. Places are compared relative to the screen size (within about 6 % of the width and 3 % of the height), so runs on different iPhones still pair.

| Label | Place | Counts as | While crawling |
|---|---|---|---|
| same | same | the same button | |
| other | same | **renamed** | tapped as the baseline's button, the screen behind it is matched to the baseline's screen |
| same | other | **moved** | tapped as the baseline's button |
| | | **removed** | a baseline button with no partner |

```
follow s000 "Profil" is now "Mein Profil" · same place · tapped as in the baseline
"Mein Profil" on s000 leads where "Profil" led · the same button, renamed
follow s000 "Workouts" moved · 180 pt down · tapped as in the baseline
```

A renamed button is only a guess: another button can have taken the old one's place. So the log and the report also say where it led. *leads to the same screen* confirms the rename; *leads elsewhere* means another button at the same place. In that case there is no second try after a fresh start. The report lists this per screen (UI: **Compare → buttons**; HTML report: under the screen; CLI: `diff` under *buttons*):

```
renamed "Profil" → "Mein Profil" · same place · leads to the same screen
moved "Workouts" · 180 pt down · leads to the same screen
removed "Hilfe"
```

List cells and links pair the same way, but give no hints: in a list the content moves and changes on its own. The hints also work for runs that did not follow the baseline, as long as the screens were matched.

`--no-follow` (`crawl.follow: false`, UI: uncheck *Follow the baseline*) explores freely as if there were no baseline.

## Ignoring areas

Some screens change on every run: an animation, a video, a live chart, a random tip. To keep them from showing up as *changed* every time, leave them out of the pixel comparison, per app and screen name:

- **Web UI:** Compare → select the screen → *Ignore an area* and drag over the head picture, or *Ignore the screen*. The comparison is made again at once; review decisions stay. Ignored areas are drawn in gray, *Remove* compares them again.
- **CLI:** `snappcrawl ignore "Aktionstaste" --area 0,120,402,560` (x, y, width, height in points), `snappcrawl ignore "Aktionstaste"` for the whole screen, `snappcrawl ignore` lists the rules, `snappcrawl ignore rm 2` removes one. `--bundle` picks another app.
- **Config:** `"diff": { "ignore": [{ "screen": "Aktionstaste", "area": { "x": 0, "y": 120, "w": 402, "h": 560 } }] }` for rules kept in the repository.

The rules are stored in `.snappcrawl/ignore.json`. An ignored screen is still matched, its buttons are still checked, and a crash or an unreachable screen still counts; only its pixels are not compared. Areas are in points, so they fit any device.

## Reports

`snappcrawl report` (or **Export** in the UI) writes one self-contained HTML file: no external fonts, scripts or images, so it opens offline, can be attached to a ticket or kept as a CI artifact, and prints on a light background.

| | `summary` (default) | `full` (`--full`) |
|---|---|---|
| App, runs, device, result, counters | ✓ | ✓ |
| Table of all screens: path, status, pixel Δ, decision, note | ✓ | ✓ |
| Screen graph with thumbnails (drag to pan, scroll to zoom, click to jump) | | ✓ |
| Base, head with changed regions, and pixel diff for every change | | ✓ |
| Thumbnails of unchanged screens | | ✓ |
| Typical size | ~15 KB | a few hundred KB to a few MB (images downscaled to 390 px) |

The result at the top:

| Result | When |
|---|---|
| **passed** | every change was reviewed and nothing was rejected (broken screens count only once approved) |
| **failed** | at least one change was rejected, e.g. a crash or an unreachable screen that is not accepted |
| **in review** | nothing rejected yet, but changes are still open |

Unchanged screens always count as passed.

## Logins and two-factor authentication

When the crawler sees a password field it logs in. Credentials come from environment variables or the config file, never from the repo:

```bash
export SNAPPCRAWL_USERNAME="qa@acme.com"
export SNAPPCRAWL_PASSWORD="…"
export SNAPPCRAWL_TOTP_SECRET="JBSWY3DPEHPK3PXP"   # only for mfa: totp
```

| `auth.mfa` | What happens |
|---|---|
| `none` | username and password only |
| `totp` | snappcrawl generates the 6-digit code from the TOTP secret (same as Google Authenticator / 1Password) |
| `prompt` | the crawl pauses and asks for the code, in the terminal or in the web UI |
| `manual` | the crawl pauses; you log in on the simulator yourself and press continue |

With `fallbackManual: true` (default), a failed automatic login also pauses for a manual one. After login the session is kept for the rest of the run.

### PIN

Many apps ask for a PIN, at the start or after the login. Set it once, of any length (4, 6, 8 digits …):

```bash
export SNAPPCRAWL_PIN="0815"
```

Or `"pin": "env:SNAPPCRAWL_PIN"` in `auth` of `snappcrawl.config.json` (always as a string in quotes, so a leading zero stays), or the *pin* field in the web UI under **Setup → Login** (sent to the local server only, never written to disk). There is no command-line option, so the PIN does not end up in your shell history. The log only shows the number of digits.

A screen counts as a PIN prompt when it says *PIN*, *Passcode*, *Geheimzahl*, *Zugangscode*, *Sicherheitscode* (or similar) and has a number pad or an input field, or when it has a number pad next to a secure field. A form with a user name and a password is a login, not a PIN. How it is entered:

- **Number pad** (the app's own buttons 0–9, or the system number pad): the digits are tapped one by one.
- **Input field:** the field is tapped and the PIN typed.
- No automatic send: a button like *OK*, *Weiter* or *Bestätigen* is tapped afterwards.
- A second prompt that looks different (*Confirm your PIN*) gets the PIN once more.

**A wrong PIN is never retried** on the same prompt, because a few wrong tries can lock the account. The log says `the PIN was not accepted · not tried again` and the crawl pauses for you to enter it on the device. Without a configured PIN the crawl pauses as well. The iPhone's own passcode (lock screen) cannot be entered this way, so keep the iPhone unlocked while crawling.

> **Use test accounts, never production accounts.** The crawler taps everything it is allowed to tap.

## Real-world apps: banners, onboarding and alerts

Real apps rarely open straight on their start screen. snappcrawl handles the usual suspects:

| What appears | What snappcrawl does | Setting |
|---|---|---|
| Onboarding sheets, "What's new", hints | Taps a dismiss button (exact label: *Alles klar, OK, Später, Nicht jetzt, Schließen, Überspringen, Got it, Not now, Maybe later, Close, Skip, …*) at start and whenever a relaunch or replay lands on an unexpected screen; up to 3 times, logged as `dismiss "…"` | `crawl.dismiss` (list of labels) |
| Cookie and privacy banners | **Never decided automatically**, except with `--intro skip` or `fresh`, where you ask for it (accepted, see below). With `--prepare` you decide yourself; otherwise the screen is skipped with a warning (a banner on the start screen ends the crawl there) | `--prepare` |
| Permission prompts (notifications, location, tracking, photos) | Answered with *Don't Allow* / *Ask App Not to Track* by default, through WebDriverAgent's alert API on iPhones and through the accessibility tree on the simulator | `crawl.systemAlerts`: `dismiss` · `accept` · `pause` |
| Links in web content | Not tapped (`action.skip "…" (web link)`), they usually open Safari | `crawl.webLinks`: `skip` · `tap` |
| A tap that brings Safari or another app to the front | Logged as `left app`, the app is brought back, nothing is registered (no crash node) | |
| A replay that lands on the wrong screen | Dismiss first, then one complete restart and replay; only then the screen is skipped with a warning | `crawl.matchThreshold` |
| Onboarding shown only on the first launch | See [App intro](#app-intro-screens-shown-only-on-the-first-start) for `--intro skip` and `--intro fresh`. In the default mode `keep`: when the app opens twice in a row on another known screen, that screen becomes the **launch screen**; the screens before it are marked *one-time* (dashed in the graph), not a warning. Paths are stored relative to the launch screen. In a diff, one-time screens are compared only when both runs have them, otherwise they show as *one-time (skipped)* | |

**`--prepare`** (in the UI: *Prepare app manually before crawl*) launches the app and pauses: *Bring the app to the screen where the crawl should start, then continue.* Use it to make the cookie decision, finish onboarding or log in by hand. The screen you leave the app on becomes the root of the graph. If a later restart does not show that screen again, snappcrawl dismisses what is in the way; if a privacy banner comes back, it pauses again.

```bash
snappcrawl crawl --device "Lena's iPhone" --bundle com.acme.app --prepare
```

Warnings collected during a run are stored in `atlas.json` (`meta.warnings`).

### App intro: screens shown only on the first start

Many apps show a welcome tour, permission prompts and a cookie banner only the first time they open. A first crawl of a fresh app sees them, the comparison run does not, so they turn up as *one-time* screens. `--intro` (in the UI: *Setup → app intro*) decides how a run deals with them:

| `--intro` | Before the crawl | Result |
|---|---|---|
| `keep` | nothing | The intro is crawled when it shows and marked *one-time*. The log names how many one-time screens there were, with a hint to `fresh` and `skip`. |
| `skip` | **A warm-up.** The app is started and the intro is tapped through. Buttons with an exact label like *Überspringen, Skip, Weiter, Continue, Los geht's, Get started, Erlauben, Allow* or one of the dismiss labels are tapped, *skip* labels first. Permission prompts are **allowed**. Cookie banners are **accepted** (*Alle akzeptieren / Accept all*). The warm-up stops at a tab bar, a login or when nothing is left to tap. Then the app is restarted, and this repeats (up to 4 times) until it opens the same way twice. | The crawl starts on the app's own start screen. The intro is not in the map, and neither run of a comparison has it. Each step is logged as `intro.skip …`. |
| `fresh` | **A reset.** The app starts like it was just installed (see below). Hints at the start are not tapped away. | Every run has the intro, so a comparison also checks the intro. A cookie banner is kept as a screen and then left through *Alle akzeptieren / Accept all*, so the crawl goes on into the app. Permission prompts follow `--alerts`. |

**How the reset works**
- **Simulator:** the app's data folder is emptied (documents, settings, caches, cookies) and its permissions are reset (`simctl privacy reset`). The keychain and app group folders stay, so an app that keeps its login in the keychain may still be logged in.
- **`--reinstall path/to/App.app`:** uninstalls the app and installs this build. This works on the simulator and on an iPhone, needs a build signed for the device, and also resets the keychain entries the app owns. `--reinstall` implies `--intro fresh`.
- **iPhone without `--reinstall`:** an iPhone cannot clear an app's data, so the crawl pauses: *Delete the app on the iPhone and install it again, then continue.* Use this for App Store apps.
- System apps of the simulator have no data folder to reset. Use `--reinstall` or `skip` for them.

**Which mode a run uses.** Without `--intro`, a run uses the mode of the app's baseline (logged as `intro fresh · like the baseline of this app`), otherwise `keep`. Choose the mode once for the first run, and every comparison starts the same way. The mode is stored in `atlas.json` (`meta.intro`).

```bash
snappcrawl crawl --bundle com.acme.app --intro skip                      # leave the intro out
snappcrawl crawl --bundle com.acme.app --intro fresh                     # simulator: reset, intro in every run
snappcrawl crawl --device "Lena's iPhone" --bundle com.acme.app --reinstall build/Acme.app
```

## Long screens: scrolling

By default a crawl sees what fits on the screen: buttons further down a long page are never tapped, and changes there go unnoticed. With `--scroll` (`crawl.scroll`, UI: Setup → *scroll long screens*, MCP `check` with `scroll: true`) every screen whose content reaches the bottom is scrolled page by page:

- **What is below is crawled.** The buttons and cells of every page become actions of the screen; before tapping one, the crawler scrolls it into view. Elements under a floating bar (the search field at the bottom of the iOS 26 Settings) are scrolled up first, so the tap does not land on the bar.
- **The whole page is compared.** The pages are joined into one tall picture, bars once at the top and bottom. A page that got longer or shorter is compared over the common height, the extra rows count as changed. Texts and buttons of all pages are in the comparison in words.
- **A scrolled screen is still that screen**, also when the app keeps the scroll position on the way back.

Scrolling is a slow swipe over 30 % of the height; how far the content moved is measured on the elements before and after, so momentum does not matter. The reach is a fixed length, half a screen per page of `crawl.maxScrollPages` (5, `--scroll-pages <n>`), cut off exactly, so two runs cover the same part of a page. Pages also end when nothing moves any more or two pages share no element. What iOS 26 changes while scrolling is kept out of the comparison: the blurred edge above a bottom bar, a floating search field that shrinks and grows, an A–Z index that stays put. Two crawls of the iOS Settings with `--scroll` compare 16 of 16 screens as identical. Cost: about 2–3 s per page. In the iOS Settings (depth 1) it found 16 screens instead of 10, among them *Datenschutz & Sicherheit*, *Apps* and *Entwickler*, all below the fold. A run with `--scroll` stores it in its limits, so `check` against such a baseline scrolls too.

## Safety: the blocklist

Elements whose label contains a blocklisted word are never tapped. Defaults: `log out`, `sign out`, `delete account`, `buy`, `purchase`, `pay now`, plus German equivalents. Extend it per app in `crawl.blocklist`. Skipped actions are logged as `action.skip`.

## Crawl order

The crawler explores **level by level** (breadth-first) and on every screen taps **navigation first**.

1. **Start screen.** It takes a screenshot and collects every tappable element.
2. **Every action of level 1.** It taps each element once.
   - A new screen gets a screenshot and joins the queue, and the crawler goes back to the start screen.
   - A known screen only gets the transition.
   - If the tap changes nothing, the crawler moves to the next element.
3. **Level 2, then level 3, and so on.** It takes the next screen from the queue and taps all of its elements, which queues the screens of the next level.
4. **Stop.** It stops when the queue is empty or a limit is reached (`maxDepth`, `maxScreens`, minutes).

New screens are not explored right away, only queued. Before every tap the crawler brings the app back to the screen it is working on. It taps *Back* when there is one, otherwise it restarts the app and replays the taps that led there. Taps on deeper screens therefore take longer.

**Which element first.** Each element gets a tier. Within a tier the order is top to bottom, then left to right.

| Tier | What | Why |
|---|---|---|
| 1 · prefer | labels from `--prefer` / `crawl.prefer`, in the order given | parts of the app you care about most |
| 2 · navigation | tab bar, navigation bar, toolbar, segmented control, menu buttons (`Menu`, `Mehr`, ids with *menu*, *sidebar*, *drawer*) | shows the main areas of the app early |
| 3 · buttons | every other button | |
| 4 · list items | list cells and links | a list usually leads to the same kind of screen |

**Which screen next.** The queue follows the same tiers within a level. Screens reached through a preferred element come first, then those reached through navigation, then buttons, then list items. A level is always finished before the next one starts.

**Tabs once per run.** The tab bar is on almost every screen. The crawler taps each tab once, on the first screen where it sees it, and remembers where it leads. On every other screen the same tab only adds the known transition to the map, without a tap and without going back. The log ends with how many tab taps were saved.

**Options**

- `--prefer "Konto,Einstellungen"` (`crawl.prefer`): elements whose label or id contains one of these words are tapped before everything else, in the order given, and their screens are explored first on their level. Case does not matter. The blocklist still wins.
- `--max-per-list 3` (`crawl.maxPerList`, default `0` = all): only the first *n* cells of each list are tapped. Ten articles in a feed usually lead to one kind of detail screen, so three are enough to see it. Skipped cells are logged (`action.skip 7 more list items (max 3 per list)`) and stored in the run (`limited` per screen). A list is a table or collection view, or, without one, cells in the same column with the same width. Only cells count: some lists, like the iOS Settings rows, are reported as buttons in the simulator and are not cut.

Both options are also in the web UI under **Setup → Limits and interruptions**, and can be stored for every crawl: `snappcrawl config set crawl.prefer "Konto, Einstellungen"`, `snappcrawl config set crawl.maxPerList 3`.

## Configuration

`snappcrawl.config.json` in your project (created by `snappcrawl init`). Values of the form `env:NAME` are read from the environment.

```json
{
  "app": { "bundleId": "com.acme.app" },
  "device": { "platform": "ios-sim", "udid": "booted" },
  "auth": {
    "username": "env:SNAPPCRAWL_USERNAME",
    "password": "env:SNAPPCRAWL_PASSWORD",
    "mfa": "totp",
    "totpSecret": "env:SNAPPCRAWL_TOTP_SECRET",
    "pin": "env:SNAPPCRAWL_PIN",
    "fallbackManual": true
  },
  "crawl": { "maxDepth": 8, "maxScreens": 200, "timeLimitMin": 20, "blocklist": ["log out", "delete account", "buy"], "systemAlerts": "dismiss" },
  "diff": { "threshold": 0.05, "minChangedRatio": 0.0005, "ignoreStatusBar": true }
}
```

| Key | Default | Meaning |
|---|---|---|
| `device.platform` | `ios-sim` | `ios-sim` (simulator) or `ios-device` (iPhone over USB) |
| `device.udid` | `booted` | simulator or iPhone, by udid or name |
| `device.wdaUrl` | `http://127.0.0.1:8100` | WebDriverAgent address for `ios-device` |
| `auth.pin` | | a PIN the app asks for, as a string (see [PIN](#pin)) |
| `crawl.against` | | compare with the baseline of another app, a second build (`--against`, see [two builds side by side](#two-builds-side-by-side)) |
| `crawl.maxDepth` | `8` | taps away from the first screen |
| `crawl.maxScreens` | `200` | stop after this many screens |
| `crawl.timeLimitMin` | `20` | stop after this many minutes |
| `crawl.settleMs` | `900` | the longest wait after a tap while the screen still looks as before (most taps are read after about half of it, see [How it works](#how-it-works)) |
| `crawl.matchThreshold` | `0.8` | similarity (0–1) from which two views count as the same screen |
| `crawl.prepare` | `false` | pause after launch for manual preparation (`--prepare`) |
| `crawl.dismiss` | DE + EN list | button labels that close onboarding sheets and hints |
| `crawl.systemAlerts` | `dismiss` | permission prompts: `dismiss`, `accept` or `pause` |
| `crawl.webLinks` | `skip` | links in web content: `skip` or `tap` |
| `crawl.follow` | `true` | with a baseline: repeat it first, a tap that lands elsewhere is tried once more (`--no-follow`, see [following the baseline](#comparable-runs-following-the-baseline)) |
| `crawl.intro` | like the baseline, else `keep` | screens shown only on the first start: `keep`, `skip`, `fresh` (`--intro`, see [App intro](#app-intro-screens-shown-only-on-the-first-start)) |
| `crawl.reinstall` | | with `fresh`: a `.app` to uninstall and install before each run (`--reinstall`) |
| `crawl.prefer` | `[]` | labels tapped before everything else, in this order (`--prefer`, see [Crawl order](#crawl-order)) |
| `crawl.maxPerList` | `0` | only the first n cells of each list, `0` = all (`--max-per-list`) |
| `crawl.scroll` | `false` | scroll long screens page by page (`--scroll`, see [Long screens](#long-screens-scrolling)) |
| `crawl.maxScrollPages` | `5` | with scroll: at most this many pages below the first (`--scroll-pages`) |
| `diff.threshold` | `0.05` | per-pixel colour tolerance (0–1); at 0.1 a white card on the light gray iOS background goes unnoticed |
| `diff.minChangedRatio` | `0.0005` | share of changed pixels below which a screen counts as unchanged |
| `diff.ignoreStatusBar` | `true` | masks the clock and battery area |
| `diff.ignoreHomeIndicator` | `true` | masks the home indicator at the bottom, which iOS tints after the screen before |
| `diff.ignore` | `[]` | areas left out of the comparison, see [Ignoring areas](#ignoring-areas) |

## Model notes (optional)

The comparison is deterministic and needs no model. If you want a one-line description and a suggested verdict (intended / bug) for each change, connect a model with your own key:

```bash
# Anthropic
snappcrawl config set ai.provider anthropic
export ANTHROPIC_API_KEY=sk-ant-…

# OpenAI
snappcrawl config set ai.provider openai
export OPENAI_API_KEY=sk-…

# Local, nothing leaves your machine
snappcrawl config set ai.provider ollama
snappcrawl config set ai.model llava
```

Then `snappcrawl diff --ai`, or **Notes** in the web UI. Global settings live in `~/.snappcrawl/config.json` (mode 600); `ai.model` overrides the default model.

## Commands

| Command | |
|---|---|
| `snappcrawl` | checklist, then the web UI · `--port --no-open` (same as `snappcrawl ui`) |
| `snappcrawl setup` | fix what is missing, step by step |
| `snappcrawl doctor` | the checklist only |
| `snappcrawl devices` | simulators and iPhones with their state |
| `snappcrawl boot <simulator>` | boot a simulator |
| `snappcrawl apps` | apps on the simulator · `--device` for an iPhone |
| `snappcrawl wda setup \| start \| stop \| status` | WebDriverAgent for iPhones · `--team --bundle-id --udid` |
| `snappcrawl check` | crawl and compare with the baseline in one go, for agents and CI · `--build --base-ref <ref> --project --scheme --set --json --junit`, exit codes 0–4 (see [With coding agents](#with-coding-agents)) |
| `snappcrawl mcp` | MCP server on stdio for coding agents |
| `snappcrawl init --agents` | AGENTS.md, CLAUDE.md, Copilot instructions and MCP configs for this repository |
| `snappcrawl crawl` | explore the app · `--bundle --then --parallel --against --scroll --scroll-pages --udid --device --label --max-depth --max-screens --minutes --mfa --prepare --alerts --dismiss --block --prefer --max-per-list --intro --reinstall --no-follow --diff` |
| `snappcrawl runs` · `runs rm <run>` | list runs, delete one with its comparisons |
| `snappcrawl baseline [run]` | show baselines, or make a run the baseline of its app |
| `snappcrawl diff [base] [head]` | compare runs (default: baseline vs the newest run after it, or the pair of `crawl --then`) · `--ai` |
| `snappcrawl review …` | list changes, or `review <id\|all> <approve\|reject\|undo>` |
| `snappcrawl report [base] [head]` | HTML report to `.snappcrawl/reports/` · `--full --out <file>` |
| `snappcrawl notes [base] [head]` | model notes for the changes |
| `snappcrawl ignore [screen]` · `ignore rm <n>` | leave a screen (or `--area x,y,w,h`) out of the pixel comparison, list or remove rules |
| `snappcrawl config` · `config set <key> <value>` | show or change global settings |
| `snappcrawl init` · `demo` · `migrate` · `help` | config file, sample data, move old data, help |

`snappcrawl diff` exits with code `1` when screens crashed or became unreachable, so it can fail a CI job. Errors print what went wrong and what to do; `--debug` adds the stack trace.

## How it works

1. **Explore.** After launch (and login), the crawler reads the accessibility tree (on the simulator straight from `idb_companion` over its local socket, which saves starting the `idb` tool for every read, tap and screenshot; `SNAPPCRAWL_IDB=cli` uses the tool), collects tappable elements (buttons, cells, tabs, links), and explores breadth-first with navigation first (see [Crawl order](#crawl-order)). To get back to a screen it first tries without a restart: from the screen that is showing, or after tapping *Back* up to three times, it follows the taps from a screen on the way. Only when that fails does it relaunch the app and replay the taps that led there. A read of the screen is reused while nothing was tapped, and the app state is only asked for when the screen no longer belongs to the app. In the iOS Settings (depth 3, 50 screens) this cut the restarts from 18 to 5, and with the direct line to `idb_companion` the crawl from 9 to about 5½ minutes.
2. **Wait until the screen is still.** After a tap the screen is first read after a third of `settleMs`; the full `settleMs` is only waited for while it still looks as before the tap. Then it is read again until two reads in a row show the same layout (type, position and size of every element; texts do not count, so a clock or a feed does not keep it waiting) and it is not empty. Without this, a read during a push animation lists the old and the new screen at once, and a read while loading lists nothing: such a screen gets wrong actions, the way back to it fails, and the pages behind it are never found. The picture of a new screen is kept once a second one a moment later agrees with it and it shows no scroll bar (iOS shows one for a moment when a list appears), so two runs do not differ by timing alone.
3. **Identify screens.** A screen's identity is a fingerprint of its accessibility structure, with numbers masked, so a clock or a counter does not create a "new" screen. Web content inside the app (ad banners, embedded pages) is left out, so a rotating banner does not either. When the fingerprint differs, a **signature** decides: the stable parts of a screen (navigation bar title, selected tab, buttons, toolbar, layout) count, feed texts in cells, numbers, dates and ads count little or not at all. Two views are the same screen from a similarity of `crawl.matchThreshold` (0.8); a different navigation bar title always means a different screen. The same rule is used for replays (every step is checked and logged as `replay s002 ok · match 0.91`) and for matching screens between two runs. Screens are named after the navigation bar title, else the selected tab, else the first large text near the top, else the action that led there; repeated names get " (2)", " (3)".
4. **Detect crashes.** After every tap snappcrawl checks whether the app process is still alive and records a crash node in the graph.
5. **Compare.** A run that [followed the baseline](#comparable-runs-following-the-baseline) knows for every screen which baseline screen it is. Otherwise screens of two runs are matched by the path of taps that reached them, then by fingerprint. Matched screenshots are compared with [pixelmatch](https://github.com/mapbox/pixelmatch); changed pixels are grouped into regions. Screens only in the new run are *new*; screens only in the baseline are *unreachable*. On matched screens, buttons are paired by label and place, which gives the [renamed, moved and removed](#label-and-place-renamed-and-moved-buttons) hints.

## Output

```
.snappcrawl/
├── baselines.json               # baseline run per app
├── ignore.json                  # areas left out of the comparison, per app
├── reports/                     # exported HTML reports
│   └── snappcrawl-<app>-<head>-<summary|full>.html
├── runs/<run-id>/
│   ├── atlas.json               # screens, edges, paths, device info
│   └── screens/s000.png …
└── diffs/<base>__<head>/
    ├── report.json              # statuses, regions, review decisions, notes
    └── s000.png …               # pixel diff images
```

Add `.snappcrawl/` to `.gitignore` (`snappcrawl init` does this).

## Limitations and roadmap

- iOS Simulator and iPhones over USB. **Next:** Android (adb + UiAutomator).
- Apps with poor accessibility labels expose fewer tappable elements; a screenshot-based fallback is planned.
- Lists with endless dynamic content can produce many similar screens; use `--max-per-list`, `maxScreens` and `maxDepth`.
- An app that really behaves differently on the same tap (Maps opens a profile sheet over a collapsed or an expanded panel) still shows a *new* screen after the retry. Mark it in the review.

## Development

```bash
npm install
npm test          # fake app, fake WebDriverAgent, fake usbmuxd: no Xcode or iPhone needed
```

Drivers implement one small interface (`resolve`, `listApps`, `launch`, `isRunning`, `elements`, `tap`, `type`, `screenshot`), see `src/drivers/ios-sim.js`, `src/drivers/ios-device.js` and `test/fake-app.js`. `test/fake-wda.js` serves the fake app as a WebDriverAgent, so the iPhone driver and the port forwarder are tested without a phone.

## Troubleshooting

- **`unable to find utility "simctl"`**: only the command line tools are active. `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`
- **`You have not agreed to the Xcode license`**: `sudo xcodebuild -license accept`
- **`Refusing to load formula … from untrusted tap`**: `brew trust facebook/fb`
- **`Unable to find application named 'Simulator'`**: `open "$(xcode-select -p)/Applications/Simulator.app"`. The window is optional; a booted simulator is enough.
- **`idb: command not found`** after `pipx install fb-idb`: run `pipx ensurepath` and open a new terminal.
- **idb fails on a very new Python:** `pipx install --python python3.11 fb-idb`.
- **No booted simulator:** `snappcrawl devices`, then `xcrun simctl boot "<name>"`.
- **Port 4747 busy:** `snappcrawl ui` picks the next free port automatically.
- **Taps land in the wrong place:** raise `crawl.settleMs` so animations finish before the screen is read.

## License

MIT
