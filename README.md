# DeepBook Studio — desktop app

One app, no terminal, no API key. Bundles:
- the DeepBook Studio UI (`renderer/`)
- a local bridge (`bridge/server-lib.js`) that talks to Claude
- the Claude Code engine itself, as a normal dependency — Electron packages
  the right native binary for whichever OS you build on/for

The only manual step left is signing in once (Settings → **Sign in to
Claude**, which opens your browser automatically) — that's true of every
app that uses your account, not something an installer can skip.

## Getting the installers (recommended: let CI build them)

You don't need a Windows or Mac machine yourself:

1. Push this folder to a GitHub repo.
2. GitHub Actions (`.github/workflows/build.yml`) automatically builds:
   - a Windows installer (`.exe`, on `windows-latest`)
   - a macOS installer (`.dmg`, on `macos-latest`)
   - a Linux `.AppImage` and `.deb` (on `ubuntu-latest`)
3. Open the finished workflow run on GitHub → **Artifacts** → download
   whichever OS you need. (Or push a tag like `v1.0.0` to also attach them
   to a GitHub Release.)

This works because each installer has to be built *on* (or for) its target
OS — Claude Code's engine ships a different native binary per platform, and
Electron's packager needs the matching one. One machine can't produce all
three; CI running on three different machines can.

## Building locally instead

If you'd rather build on your own machine (only produces the installer for
*that* machine's OS):

```
npm install
npm run dist        # auto-detects your OS
# or explicitly:
npm run dist:win
npm run dist:mac
npm run dist:linux
```

Output lands in `release/`.

## Running without packaging (dev mode)

```
npm install
npm start
```

Opens the app in a normal window, bridge running inside the same process.

## Development & release workflow

Every push to `main` runs three checks automatically, before anything gets
published:
1. **Lint** (`npm run lint`) — catches bugs like calling a function that no
   longer exists, straight away instead of shipping broken JS.
2. **Build** — all four installers.
3. **Smoke test** (Linux only) — actually launches the packaged app headless
   and checks it doesn't crash in the first 10 seconds.

None of that publishes anything — it just tells you the commit is healthy.
Tagging is what ships an update to people who already have the app
installed, so keep those two steps separate:

```
# 1. Push to main, let CI go green first
git push origin main

# 2. Try it for real without touching anyone's install — tag a prerelease.
#    IMPORTANT: bump the "version" field in package.json to the SAME string
#    first (e.g. "1.2.0-beta.1") — electron-builder decides "is this a
#    prerelease?" from that version string, not from the git tag name, so
#    a mismatched tag/version silently builds a normal (non-prerelease) one.
npm version 1.2.0-beta.1 --no-git-tag-version   # writes package.json for you
git commit -am "Bump to 1.2.0-beta.1"
git tag v1.2.0-beta.1 && git push origin main v1.2.0-beta.1
# → publishes a GitHub Release marked "prerelease". electron-updater's
#   default channel ignores prereleases, so existing installs won't see it.
#   Download it yourself from the Release page and actually try it.

# 3. Happy with it? Promote to the real version the same way
npm version 1.2.0 --no-git-tag-version
git commit -am "Bump to 1.2.0"
git tag v1.2.0 && git push origin main v1.2.0
# → publishes the "latest" release. Existing installs will find this one
#   next time someone clicks Check for Updates.
```

## Diagnostics

Settings → **Diagnostics** has two buttons:
- **Open Logs Folder** — reveals the log file on disk (everything the app
  logs, including startup errors you'd otherwise never see since a
  packaged app has no visible terminal).
- **Report an Issue** — opens a pre-filled GitHub issue with the app
  version, platform, and the last ~60 log lines attached. Nothing is sent
  anywhere unless you click it and submit the issue yourself.



```
renderer/DeepBook_Studio_v4_4.html   the exact app UI, unchanged from the
                                      standalone version — still just does
                                      fetch('http://127.0.0.1:8787/...')

bridge/server-lib.js                 same bridge logic as the standalone
                                      version, refactored to resolve and
                                      spawn the bundled Claude Code binary
                                      directly instead of a PATH lookup

main.js                              starts the bridge on app launch, opens
                                      the window, and handles the one-time
                                      sign-in flow (opens your browser,
                                      detects when it's done)

preload.js                           the only bridge between the page and
                                      Electron's main process — exposes
                                      exactly one thing: "start sign-in"
```

If you ever want to swap in `renderer/DeepBook_Studio_v4_4.html` for a
newer export of the app, drop the new file in with the same name (or update
the path in `main.js`) — nothing else needs to change, since the app talks
to the bridge purely over HTTP either way.
