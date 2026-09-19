# V Living Trading Tracker

A standalone deals / pipeline / proposals tracker built for V Living Trading (tiles & sanitaryware trading). Runs as a small local web app with a shared SQLite database, so multiple people on the same network can log in and use it from their own machines.

Brand palette and typography carried over from the NVF brand guidelines — see [Branding](#4-branding) below. All figures are in **AED**.

## What it does

- Tracks deals through a pipeline: **Lead → Qualified → Proposal Sent → Negotiation → Won / Lost**
- Records customer, contact, product category (Tiles / Sanitaryware / Both / Other), value, cost, probability, expected close date, owner and notes
- **Gross profit tracking** — enter the cost against a deal and the app derives margin % and GP (see [Gross profit](#gross-profit))
- Dashboard with a **period dropdown**: This Month, Year to Date, Full Year (previous/current/next two years), or a custom date range
- KPI cards: open pipeline value, weighted pipeline, pipeline gross profit, confirmed/won value, won gross profit, win rate
- Charts: monthly pipeline vs. won trend, pipeline by stage, pipeline by product category
- Tables: top open deals, recently won deals
- Basic login with two roles: **Admin** (manages users & settings) and **Sales** (manages deals)

## 1. Prerequisites — install Node.js

This app needs **Node.js v22.5 or newer** installed once on whichever machine will run the server (it uses Node's built-in SQLite support, so there's nothing to compile — works even on machines without Python/build tools, including ARM64 Windows).

Install it either by:
- Downloading the LTS installer from https://nodejs.org and running it, or
- Running this in PowerShell (requires winget, already on this PC):
  ```bash
  winget install OpenJS.NodeJS.LTS
  ```
  Close and reopen your terminal afterwards so `node`/`npm` are on PATH.

## 2. Install & run

**Double-click `V Living Trading Tracker`** (the shortcut with the VL icon in this folder).

That's it. A small black window opens showing the tracker is running, and your browser opens at the login page automatically. On the very first run it takes a minute or two to set itself up.

Two things to know about that black window:
- **Leave it open** while you're using the tracker. Closing it shuts the tracker down.
- If you double-click the icon again while it's already running, it just reopens the browser rather than starting a second copy.

If Node.js isn't installed, the window tells you so and points you at the download instead of failing silently.

<details>
<summary>Running it from a terminal instead</summary>

```bash
npm install
npm start
```

You'll see `V Living Trading Tracker running at http://localhost:3000`. Open that address in a browser.
</details>

### Your first login

The very first time the app starts against an empty database, it creates one administrator account and **prints the password to the console once**:

```
============================================================
 FIRST RUN - administrator account created
============================================================
 Email:    admin@vliving.local
 Password: mRuxj9YLIhJV
============================================================
```

Write it down — it isn't stored anywhere readable and isn't shown again. Change it via the **Account** button after logging in, then create real accounts from the **Users** page (admin only).

To choose your own instead of getting a random one, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` before the first run (see [.env.example](.env.example)). No password is ever hardcoded in the source.

### Optional: load example deals to see the dashboard populated

```bash
node scripts/seed-sample-data.js
```

This only inserts sample rows if the deals table is empty — safe to run once on a fresh install, and it's a no-op afterwards.

## Gross profit

Each deal has a **Cost** field. Everything else is derived, so there's only ever one number to keep up to date:

| Column | How it's calculated |
| --- | --- |
| Cost | What you enter — what the goods cost you |
| Margin % | GP ÷ deal value (margin on the sell price, not markup on cost) |
| GP (AED) | Deal value − cost |

Cost is optional. Leave it blank on an early-stage deal and the margin and GP columns show `—` rather than reading as 100% margin. The deal form shows the resulting GP and margin live as you type, and loss-making deals are shown in Burnt Orange.

On the dashboard, **Pipeline Gross Profit** and **Won Gross Profit** total the GP for the selected period, with the blended margin underneath. These only count deals that have a cost captured, and the sub-line says how many that is (e.g. "4 of 5 deals costed") so a partial figure is never mistaken for the whole picture.

## 3. Letting colleagues on the network use it

The server needs to keep running on one machine (a desk PC, small server, etc.). Everyone else just opens a browser and goes to that machine's address.

1. On the machine running the server, find its local IP address: `ipconfig` (look for "IPv4 Address", e.g. `192.168.1.42`).
2. Make sure Windows Firewall allows inbound connections on port 3000 for Node.js (Windows will usually prompt you the first time you run `npm start` — allow it on Private networks).
3. Colleagues on the same network/WiFi open `http://192.168.1.42:3000` in their browser.

To keep it running in the background (so it survives a logout), consider a tool like [pm2](https://pm2.keymetrics.io/) or a scheduled task that runs `npm start` at machine startup — ask if you'd like this set up.

## 4. Branding

The colour palette and typography come from the NVF brand guidelines and were **kept through the rename to V Living Trading**. New logo artwork is still to come — see [Logo](#logo) below.

Reference documents are kept in the [brand/](brand) folder:

- `NVF-Brand-Guidelines.pdf` — the full brand guide (palette, logo rules, typography, tone of voice)
- `NVF-Example-Document-YASRA-Warehouse-Investment.pdf` — an example document, used as the reference for layout and typographic style

Both are excluded from version control via `.gitignore` — the guidelines are permission-controlled and the example document is marked confidential, so they should not end up in a repo. They are also **not** served by the web app; they sit outside `public/`.

### What's applied

**Colour palette** — only approved brand colours are used. Lighter shades are opacity tints of Deep Brown rather than new hues, per the "do not use unauthorized colours" rule. Defined as CSS variables at the top of [public/css/style.css](public/css/style.css):

| Token | Hex | Use in app |
| --- | --- | --- |
| Deep Brown | `#361C0E` | Top bar, login background, body text |
| Copper Bark | `#734423` | Secondary text, hover states, Proposal Sent stage |
| Burnt Orange | `#963F16` | Primary buttons, Negotiation stage, Won bars |
| Cinnabar Heat | `#DD4F0A` | Won/confirmed accents (secondary palette) |
| Mineral Sand | `#C2AF98` | Hairline borders, pipeline bars, Qualified stage |
| Beige | `#EFDDC9` | Row hover, hint panels, Lead stage |
| Soft Canvas | `#F5F0E7` | Page background, text on dark |

**Typography** — the brand's font suite, self-hosted in `public/fonts/` so it works with no internet connection:
- **Outfit** — headings and large figures (per the guidelines' heading spec)
- **Jost** — body text, subtitles and buttons, used uppercase with wide letter-spacing for micro-labels, mirroring the device used throughout the reference documents

### Logo

**The current wordmark is a typographic placeholder, not final artwork.** The previous NVF logo was removed during the rename rather than left showing the wrong company name. In its place, "V Living" is set in Outfit ExtraLight with wide letter-spacing, in brand colours:

- **Top bar** — `V LIVING` in Soft Canvas on Deep Brown (`.logo-mark` in [public/css/style.css](public/css/style.css))
- **Login screen** — `V LIVING` over a smaller `TRADING`, in Burnt Orange on Soft Canvas (`.login-card .logo-lockup`)
- **App icon** — a `VL` monogram, `public/img/vliving-tracker.ico`, used by the desktop shortcut

**To drop in real artwork when you have it:** put the file in `public/img/`, then replace the font rules in `.logo-mark` and `.login-card .logo-lockup .mark` with a fixed `width`/`height` plus `-webkit-mask`/`mask` pointing at your file, and set `background` to the brand colour you want it tinted. Using a mask rather than an `<img>` means one file works in any brand colour. Comments in the stylesheet mark both spots.

**Note:** card surfaces use white, which is not itself a palette colour, as a neutral paper ground for data tables — consistent with the near-white panels in the reference documents. Change `--surface` to `#F5F0E7` if you'd prefer strict Soft Canvas throughout.

**Company name / currency:** set from the Users page (admin) → Company Settings. Currency is AED by default; changing it there updates every figure across the app.

## 5. Data & backups

All data lives in `data/tracker.db` (created automatically on first run). It's excluded from git via `.gitignore` so it never gets committed accidentally.

**Backing up correctly matters here.** The database runs in WAL mode, which means recent changes can still be sitting in the `tracker.db-wal` file rather than in `tracker.db` itself. Copying only `tracker.db` can silently give you a backup that's missing your latest work. Either:

- **Stop the app first**, then copy `tracker.db` — a clean shutdown folds the WAL back into the main file; or
- Copy **all three** files together (`tracker.db`, `tracker.db-wal`, `tracker.db-shm`) while it's running.

## Notes & simplifications (MVP scope)

- Reporting currency is a single app-wide setting (AED by default), not per-deal — simplest approach unless you're regularly dealing in multiple currencies at once.
- Single light theme only, matching the brand's warm/light identity — no dark mode, to avoid rendering the brand in unapproved tones.
- Login sessions are kept in server memory, so everyone is logged out if the server restarts. Fine for an internal tool; can be upgraded to persistent sessions later if needed.
- No audit trail / deal history yet (just current state, plus created/updated timestamps). Can be added if you want a change log per deal.
- Cost is a single figure per deal, not a line-item breakdown — enough for margin reporting, but it won't itemise freight, duty or landed cost separately. Say the word if you need that split out.

## Project structure

```
V Living Trading Tracker.lnk       <- double-click this to run it
Start V Living Trading Tracker.cmd    the launcher the shortcut points at
server.js           Express server + all API routes
db.js               SQLite schema + seed data
scripts/            Optional helper scripts (sample data)
brand/              Brand guidelines + example document (reference, not committed)
public/             Frontend (static HTML/CSS/JS, no build step)
  login.html
  index.html          Dashboard
  deals.html          Deal list + add/edit/delete
  users.html          User & settings management (admin)
  js/                 Page scripts + vendored Chart.js
  css/style.css       All styling & brand tokens
  fonts/              Self-hosted Outfit + Jost (brand font suite)
  img/                App icon (VL monogram)
data/               SQLite database file (created at runtime)
```
