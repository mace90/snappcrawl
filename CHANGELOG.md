# Changelog

## Unreleased

### Long screens: scrolling
- `--scroll` (`crawl.scroll`, `--scroll-pages <n>` / `crawl.maxScrollPages`, UI field, MCP `scroll`): screens whose content reaches the bottom are scrolled page by page. Their buttons below the fold become actions (scrolled into view before the tap), their texts count in the comparison, and the pages are joined into one tall picture.
- Swipes are slow (30 % of the height in 1 s); the real shift is measured on elements both reads have. Pages end when nothing moves, at the page limit, or when two pages share nothing.
- A floating bar at the bottom (the search field of the iOS 26 Settings) is recognised as what stays put while the content moves: an element under it is scrolled up before the tap, and the tall picture shows it once.
- A screen is recognised in any scroll position (its pages' fingerprints and signatures).
- Two runs show the same tall picture: the reach is a fixed length (half a screen per `maxScrollPages`), cut off exactly, instead of a number of swipes whose reach varies with momentum; the shift is measured again after each picture; new rows are taken above the blurred edge iOS 26 draws over a bottom bar; the bottom bar itself comes from the first page; what stays put while scrolling (an A–Z section index) shows only once; a floating search field that iOS shrinks and grows while scrolling is left out of the lower pages. iOS Settings, depth 1, scrolled twice: 16 of 16 screens identical.
- Comparing pictures of different heights (a page that got longer): the common part is compared, the extra rows count as changed; before, the whole screen counted as 100 % changed. Status bar and home indicator masks use one screen's height.
- Drivers: `swipe` on the simulator (idb_companion HID swipe, or `idb ui swipe`) and on iPhones (WebDriverAgent `dragfromtoforduration`).
- iOS Settings, depth 1: 16 screens instead of 10.
- Fix: an app that was already in front before the start counted as not started (the launch wait of the previous fix).

- Fix: after a launch the simulator shows the app that was in front before, or the home screen, for a moment, on a cold start for seconds. The crawler took that for the app's first screen and every tap after it for a crash. It now waits until the app is in front (its own label once known), up to 15 s, and otherwise stops with "… did not come to the front".

## 0.4.0

### Ready to publish
- npm metadata (`mcpName`, keywords, author, `publishConfig`), `server.json` for the official MCP Registry, a Claude Code plugin (`.claude-plugin/plugin.json` with the MCP server, `skills/snappcrawl/SKILL.md` that tells Claude when and how to check an iOS app) and a marketplace in the same repository (`/plugin marketplace add mace90/snappcrawl`), a Homebrew formula template, and `RELEASING.md` with every publishing step in order. Nothing is published yet.
- `snappcrawl init --agents --npx` writes `npx -y snappcrawl mcp` into the MCP configs, for repositories cloned without a global install.
- README: install for every agent and CI at the top, a picture of a real comparison.

### Build from Xcode and CI
- `check --build` (and `crawl --build`) builds the app in the folder for the Simulator (`xcodebuild`, workspace before project, the only or the like-named scheme), installs it and takes the bundle id from the build. `--project`, `--scheme`, `--configuration`, `--set KEY=VALUE`.
- `--base-ref <git ref>` builds that state in a temporary worktree, crawls it first as the baseline and then compares the working tree with it: a regression check of a change without keeping a baseline. MCP `check` takes `build`, `baseRef`, `dir`, `project`, `scheme`, `buildSettings`.
- GitHub Action (`uses: mace90/snappcrawl@main`, `action.yml`): installs idb and snappcrawl from the action's own source, boots the newest iPhone simulator, builds and crawls the pull request's base and head, writes the job summary, keeps one pull request comment up to date, uploads report, JSON and JUnit, fails on `broken` (or `changes`, or `never`).
- `--junit <file>` for `check` and `diff`: one test case per screen. On GitHub Actions `check` also appends its Markdown result to the job summary.
- `examples/ios-demo`: a small SwiftUI app (tabs, list, detail, form, sheet) with a variant build (`-DVARIANT_B`), used by `.github/workflows/demo.yml`.
- iOS 26 tab bars: SwiftUI lists the tab bar as one empty group. The simulator driver reads the tabs from the automation tree (and, where that names them after their symbols, at their place), with the selected tab. Before, tab apps were crawled without their tabs.
- Tabs count by their place in a screen's identity (signature, fingerprint), not by their label: iOS 26 names a tab after its symbol in some reads (`house`) and after its title in others (`Start`), which made one screen look like two. Baselines of tab apps made before should be crawled again.
- Screen names: a heading at the top (how iOS 26 lists a SwiftUI navigation title) comes before the selected tab.
- `diff.threshold` is now 0.05 (was 0.1). At 0.1 a new white row on the light gray background of an iOS list measured 0.04 % and counted as unchanged; at 0.05 it is 0.13 %. Unchanged screens of the iOS Settings stay at exactly 0 either way.

### For coding agents
- `snappcrawl mcp`: an MCP server on stdio (JSON-RPC by hand, no SDK) for Claude Code, Codex, Copilot, Cursor. Tools: `status`, `list_apps`, `install_app`, `check`, `check_status`, `stop`, `compare`, `screen` (with the pictures as images), `review`, `set_baseline`, `ignore`. Server instructions tell an agent when to check and how to read the result. A long check answers with a job id within `wait` seconds (some clients end tool calls after 60 s) and sends progress notifications.
- `snappcrawl check`: crawl and compare with the baseline in one go; the first check saves the baseline. Exit codes: 0 passed, 1 broken or rejected, 2 changes to review, 3 needs a person, 4 setup.
- `--json` for `check`, `diff`, `runs`, `apps`, `devices`, `doctor`: one JSON document on stdout, the log on stderr. `diff --markdown` for pull requests.
- Changes in words: every screen stores its texts; a comparison lists the texts that came and went (numbers count as the same text) beside the buttons renamed, moved or removed. A screen with other texts or buttons counts as changed even with the same pixels.
- Never stuck waiting: without a terminal, with `CI`, `--json` or `--no-input`, a crawl that needs a login, a code or a PIN stops with exit code 3 and says which variables to set.
- A crash the baseline had too is marked `known` and does not make a check `broken`.
- `check` takes the limits of the baseline unless given. Screens a run did not reach because of its screen or time limit count as *not reached* instead of *unreachable* (`meta.stopped`).
- `snappcrawl init --agents`: a *UI checks with snappcrawl* section in `AGENTS.md`, an import in `CLAUDE.md`, `.github/copilot-instructions.md`, and the MCP server in `.mcp.json`, `.vscode/mcp.json`, `.cursor/mcp.json`. Marked blocks, other content untouched, idempotent.

### Faster on the simulator: idb_companion directly
- Reading the screen, tapping and screenshots go straight to `idb_companion` over its local socket (gRPC over HTTP/2 with Node's own `http2`, no new dependency) instead of starting the `idb` command line tool each time: a read takes 0.09 instead of 0.3–0.44 s, a tap 0.1 instead of 0.4 s, a screenshot 0.28 instead of 0.58 s. Same elements, pixel-identical pictures. If the companion cannot be reached or answers twice with an error, the crawl goes on with the `idb` command line; `SNAPPCRAWL_IDB=cli` always uses it.
- After a tap the screen is read after a third of `settleMs` and then until it stands still. The full `settleMs` is only waited for while the screen still looks as before the tap, so a transition that starts late is not missed.
- Following the baseline, a tap whose baseline screen is slow to come (the app asks its server first) gets a little longer before it counts as leading elsewhere.
- In the iOS Settings (depth 3, 50 screens, following the baseline): 5:27 instead of 7:11 minutes. Compared with the baseline: 50 of 50 screens found again, nothing new or unreachable; left as changed is only the animated *Aktionstaste*.

### Steadier pictures
- A new screen's picture is kept once a second picture a moment later agrees with it and it shows no scroll bar. iOS shows a list's scroll bar for a moment when the list appears or grows; depending on timing it was in one run's picture and not in the other's. The same check waits out the last points of a sheet sliding in. A screen that never stands still (an animation) keeps its last picture after about 3 s.
- The home indicator at the bottom is left out of the comparison like the status bar (`diff.ignoreHomeIndicator`, on by default): iOS 26 tints it after the screen before, so it differed between runs.
- Fix: an app that reopens on the screen it was left on (the iOS Settings do) was taken for a new launch screen, and everything before it for a one-time intro. Now the crawler goes back with the app's back button.

### Ignoring areas
- Per app and screen name, an area or a whole screen can be left out of the pixel comparison: Compare → *Ignore an area* (drag over the picture) or *Ignore the screen*; `snappcrawl ignore <screen> [--area x,y,w,h]`, `ignore rm <n>`; `diff.ignore` in the config. Stored in `.snappcrawl/ignore.json`, in points.

### Two builds at the same time
- `crawl --then <bundle> --parallel <simulator>` (UI: *the second build runs → at the same time on …*) crawls the test build on a second simulator while the baseline is crawled, about half the time. The test build does not follow the baseline then; its screens are matched afterwards.

### Faster
- Going to a screen without a restart: from the screen that is showing, or after up to three *Back* taps, the crawler follows the taps from a screen on the way. A relaunch is only the fallback. In the iOS Settings (depth 3, 50 screens): 5 restarts instead of 18, about 7 instead of 9 minutes. The comparison of two runs: 50 of 50 screens found again.
- A *Back* that changes nothing is not tapped again: the app is restarted at once.
- A screen read is reused while nothing was tapped. The app state (crash, other app) is only asked for when the screen no longer belongs to the app, which saves one call per tap. After a crash the crawler no longer waits for the home screen to stand still.
- Comparisons write a diff image only for changed screens (50 screens: 7 instead of 15 seconds).
- The list of runs is read again only for runs whose `atlas.json` changed, so the web UI stays fast with many runs.

### PIN
- New setting `auth.pin` (`SNAPPCRAWL_PIN`, or the *pin* field in the web UI): a PIN of any length that the app asks for. On a number pad the digits are tapped one by one, otherwise it is typed into the field. A send button is tapped if needed, and a confirmation prompt gets it once more.
- A wrong PIN is never retried on the same prompt (it could lock the account): the crawl warns and pauses for you. Without a PIN it pauses too. The log shows only the number of digits.
- A login followed by a PIN is handled in one go.

### Two builds side by side
- `crawl --bundle com.acme.app --then com.acme.app.beta`: crawls the first app as the baseline, then the second against it, then compares. Web UI: Setup → App → *then crawl*.
- `--against <bundle>` (`crawl.against`, UI field): one run compared with the baseline of another app. It follows that baseline and takes over its intro mode. The run stores `meta.against` and `meta.baseline`.
- `diff`, `review`, `report` and the Compare tab without arguments compare such a pair.

### Label and place: renamed and moved buttons
- Buttons of a run are paired with the baseline's by accessibility id, label, then place (relative to the screen size). The same place with another label counts as **renamed**, the same label at another place as **moved**.
- Following the baseline, a renamed or moved button is tapped as the baseline's, and the screen behind it is matched to the baseline's screen (from a similarity of 0.6). The log says whether a renamed button leads where the old one did. A button that only shares the place gets no second try.
- Reports (UI, HTML, CLI) list renamed, moved and removed buttons per screen, each with *leads to the same screen* or *leads elsewhere*. List cells and links give no hints.

### Comparable runs: follow the baseline
- A run with a baseline repeats it first. It visits the baseline's screens in the order the baseline explored them, each with its actions in the baseline's order. A tap that leads somewhere else is tried once more after a fresh start.
- At the screen limit the baseline's screens are still visited; the limit applies to what is new.
- Every screen stores the baseline screen it matches (`base`), and `diff` matches by that first. Each run stores its exploration order (`meta.order`).
- Two crawls of Maps in the simulator with 12 screens: freely, 1 new and 1 unreachable screen. Following the baseline: 12 of 12 found again, nothing unreachable.
- `--no-follow` / `crawl.follow: false` / UI checkbox to explore freely.
- Fix: two runs started in the same second no longer share a folder.
- Fix: after a tap or a launch, the screen is read until it stands still: two reads with the same layout, not empty. A read during a push animation used to list the old and the new screen at once, for example the iOS Settings list plus *Bedienungshilfen* with 29 elements instead of 16. Such a screen got wrong actions, the way back to it failed, and the pages behind it were missing from the run. Runs made before this fix can be poor baselines, so crawl a new one.

### App intro: skip it or see it in every run
- New option `--intro keep|skip|fresh` (`crawl.intro`, UI: Setup → app intro) for screens an app shows only on its first start.
- `skip`: a warm-up before the crawl taps through the intro (skip and continue buttons, dismiss labels), allows permission prompts and accepts cookie banners. It restarts the app until it opens the same way twice, then crawls without the intro.
- `fresh`: resets the app before the crawl, so every run, including the comparison, has the intro. On the simulator it clears the data folder and permissions; `--reinstall <App.app>` uninstalls and installs a build (simulator and iPhone); on an iPhone without a build the crawl pauses and asks you to reinstall the app.
- With `skip` and `fresh` a cookie banner is accepted. With `fresh` it stays in the map as a one-time screen, and hints at the start are not tapped away.
- Without `--intro` a run uses the mode of the app's baseline. The mode is stored in `meta.intro`. In `keep` mode the log names the one-time screens and points to `fresh` and `skip`.

### Crawl order: navigation first
- On every screen, elements are tapped by tier: preferred labels, then navigation (tab bar, navigation bar, toolbar, segmented control, menu buttons), then other buttons, then list cells and links. Within a tier: top to bottom, left to right. Before, the order was only by position, so the tab bar at the bottom came last.
- The queue follows the same tiers within a level: screens reached through navigation are explored before those reached through buttons and list items. Still level by level.
- Each tab is tapped once per run. On other screens the same tab only adds the known transition, without a tap and the way back.
- Bars are found by position (an element counts when at least 75 % of it lies inside the bar), so they also work in the simulator, where idb reports them as plain groups. The simulator's back button is recognised by its role even when it carries the previous screen's title: it is no longer tapped as an action, and is used to go back instead of restarting the app.
- New option `--prefer a,b` / `crawl.prefer`: labels tapped before everything else, in the order given.
- New option `--max-per-list n` / `crawl.maxPerList`: only the first n cells of each list.
- Both in the web UI (Setup → Limits and interruptions). `config set` stores list settings (`crawl.prefer`, `crawl.blocklist`, `crawl.dismiss`) as lists.
- README: a new section "Crawl order" explains the algorithm and the options.

## 0.3.0 · 2026-11-26

### New name: snappcrawl
- The project was called **snapcrawl** before. Command, package, data folder (`.snappcrawl/`), config file (`snappcrawl.config.json`), home folder (`~/.snappcrawl/`, including WebDriverAgent), environment variables (`SNAPPCRAWL_*`), report file names and the suggested WebDriverAgent bundle id use the new name. Repository: https://github.com/mace90/snappcrawl
- Moving over: the old `.snapcrawl/`, `snapcrawl.config.json`, `~/.snapcrawl/` and `SNAPCRAWL_*` are still read while the new ones do not exist, with a one-time hint. `snappcrawl migrate` moves data and config, renames `env:` references and adds `.snappcrawl/` to `.gitignore`. Reinstall with `npm i -g github:mace90/snappcrawl` (and `npm uninstall -g snapcrawl`).

### Everything in the web UI, everything in the CLI
- `snappcrawl` without arguments checks the setup and opens the web UI.
- Web UI: device list with Refresh and boot by click; iPhone status (connected, trust, locked, Developer Mode, WebDriverAgent set up / running / in control); WebDriverAgent setup with the team id filled in and live progress, start, stop; a crawl on an iPhone starts WebDriverAgent itself; problems on the iPhone appear as hints with the action to take.
- Setup per run: permission prompts, dismiss labels, blocklist, prepare. Runs can be deleted (confirmed in the page). New Settings tab: AI provider, model and API key (stored in `~/.snappcrawl/config.json`, mode 600, shown masked) and the system checklist.
- New commands: `setup`, `boot <simulator>`, `runs rm <run>`, `notes`; crawl options `--minutes --alerts --dismiss --block`. UI and CLI call the same functions (`src/control.js`, `src/doctor.js`); `src/actions.js` lists every action with its UI place, command and route, checked by a test.

### Terminal
- Start banner (ANSI Shadow wordmark with the logo), compact line under 100 columns, none without a terminal, with `NO_COLOR` or in CI; truecolor, 256 or 16 colours.
- Setup checklist with a spinner per line, grouped into system, devices, iphone and optional, with the exact fix next to anything missing.
- `snappcrawl setup` walks through every missing piece: explains it, runs the fix after a yes, shows sudo commands for you to run, describes iPhone and Xcode steps.
- Crawl progress as an estimate, in the CLI status line and the Run tab: percent and time left, from the taps tried against the taps found so far and bounded by the screen and time limits (it adjusts as new screens appear).
- Headings with a thin rule, aligned tables, a live status line (progress, time left, screens, transitions, taps, time) during a crawl, errors as a short block with cause and fix; stack traces only with `--debug`.

## 0.2.0 · 2026-11-26

### Real iPhone over USB
- New driver `ios-device`: finds iPhones with `devicectl`, drives them through WebDriverAgent (tap, type, app state, screenshots, permission alerts), with fallbacks for older WDA endpoints and a clear message when WDA is not reachable or lost control after the iPhone was locked.
- `snapcrawl wda setup | start | stop | status`: builds the newest WebDriverAgent release with your team, starts it on the iPhone and forwards port 8100 through usbmuxd (built in, no iproxy needed).
- `--device` for `crawl` and `apps`, `devices` lists simulators and USB iPhones, `doctor` checks devicectl, Developer Mode, usbmuxd and WDA. The web UI shows USB iPhones and how to start WDA.
- Diffs mask the measured status bar at the screenshot's pixel scale.

### Real-world apps
- `--prepare` (UI: *Prepare app manually before crawl*): pause after launch; the screen you leave the app on becomes the root.
- Onboarding sheets and hints are dismissed (`crawl.dismiss`); cookie and privacy decisions are never made automatically.
- Permission prompts are denied by default (`crawl.systemAlerts`: dismiss, accept, pause).
- Links in web content are skipped; a tap that opens Safari or another app is logged as *left app*, the app is brought back.
- Screen identity by signature similarity (`crawl.matchThreshold`, 0.8): rotating ads, headlines, prices and web content no longer create new screens or break replays. Different navigation bar titles stay different screens.
- Replays check every step, dismiss interruptions, resume from the deepest known screen and restart once before giving up; matches are logged.
- Onboarding shown only once is marked *one-time*; the screen the app opens on afterwards becomes the launch screen. Diffs show missing one-time screens as *one-time (skipped)*, not as unreachable.
- Better screen names: navigation bar title, selected tab, large text, then the action; duplicates are numbered.

### Baselines, review and reports
- One baseline per app, run history in the UI, app names.
- Standalone HTML reports (`snapcrawl report`, `--full`; Export in the UI) with result passed / failed / in review.
- `snapcrawl review` to approve or reject changes from the terminal; `diff`, `review` and `report` compare the newest run after the baseline by default.

## 0.1.0

- First release: crawler for the iOS Simulator (idb), login with TOTP, manual or prompted 2FA, blocklist, crash detection.
- Pixel diff between runs (same, changed, new, broken), local web UI with live crawl, screen graph and review, optional model notes, demo data.
