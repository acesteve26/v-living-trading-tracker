# V Living Trading Tracker

A deals / pipeline / proposals tracker built for V Living Trading (tiles & sanitaryware). A Node.js web app backed by PostgreSQL, designed to be hosted on Render so the sales team can reach it from anywhere with a login.

Brand palette and typography carried over from the NVF brand guidelines — see [Branding](#4-branding) below. All figures are in **AED**.

## What it does

- Tracks deals through a pipeline: **Lead → Qualified → Proposal Sent → Negotiation → Won / Lost**
- Records customer, contact, product category (Tiles / Sanitaryware / Marble / Wallpaper / Furniture / Mixed / Other), value, cost, probability, expected close date, owner and notes
- **After the sale** — a won deal has **Delivered** and **Paid** tick boxes, each saved instantly with the date and who ticked it. A won deal stays on the radar until both are ticked: Needs Attention flags it if it is still undelivered 30 days after the win, or unpaid 30 days after delivery, or if its next action runs late. Accounts can tick Paid (and only Paid). Deals → *Won – awaiting delivery* and *Won – awaiting payment* list what is outstanding
- **Customers are remembered** — start typing a customer name on a deal and the ones already on the books are suggested; pick one and their contact name, email and phone fill themselves in from the last deal with them. Anything typed by hand is never overwritten
- **Documents on a deal** — quotes, purchase orders, invoices and spec sheets, dropped anywhere on the deal window or picked from a file dialog, up to 50 MB per deal. PDFs and images open in a preview inside the app; everything else downloads
- **Gross profit tracking** — enter the cost against a deal and the app derives margin % and GP (see [Gross profit](#gross-profit)). Where no cost has been captured, the dashboard's chart and deal tables estimate GP at 20% and mark every such figure with an asterisk; the headline KPI tiles stay actual and never use the estimate
- Dashboard with a **period dropdown**: This Month, Year to Date, Full Year (previous/current/next two years), or a custom date range
- KPI cards: open pipeline value, weighted pipeline, pipeline gross profit, confirmed/won value, won gross profit, win rate
- Charts: monthly pipeline vs. won trend, pipeline by stage, pipeline by product category
- Tables: top open deals, recently won deals
- Login with four roles: **Admin** (manages users & settings), **Sales** (manages deals), and **Management** / **Accounts**, which can view everything and run reports but not change deals
- **Expenses** — the overheads that sit alongside the pipeline (rent, salaries, freight, duty…), with period filters for month, quarter, year to date and full year, and a breakdown by category. Everyone can see them; admin and accounts can add and edit them
- **Activity log** — a per-person and whole-system history: sign-ins and failed attempts, deals created and edited, documents attached, reports run, and every admin change to an account. Opens from the Users tab; readable by admin and management only

## 1. Prerequisites — install Node.js

Running this locally needs two things:

1. **Node.js v22.5 or newer** — nothing here needs compiling, so it works on machines without Python or build tools, including ARM64 Windows.
2. **A PostgreSQL database.** The app will not start without one. Create a free database on Render for development, then put its **External Database URL** into `.env` as `DATABASE_URL` (see [.env.example](.env.example)).

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
 Password: <a random 12-character password>
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

### The 20% assumption

A deal with no cost recorded would otherwise contribute nothing to a gross profit figure, leaving a month looking emptier than it is. So in two places — the **Gross Profit by Month** chart and the two deal tables beneath it — an uncosted deal is estimated at a **20% margin**, set by `ASSUMED_GP_MARGIN_PCT` in [constants.js](constants.js).

Every figure that leans on it is marked:

- an asterisk on the individual margin and GP cell
- a footnote under each table and the chart saying how many were estimated
- the chart tooltip naming the count for that month
- on the **Deals** tab, where salespeople work, the cost cell reads "Add cost" and the margin and GP cells are tinted in Cinnabar with the estimate shown — so a missing cost looks like a job to do rather than a dash that reads as "nothing here". **Deals → No cost recorded** lists exactly those deals

The **KPI tiles deliberately do not use it**. Those stay actual, counted only across deals with a real cost, so the headline numbers can never be inflated by an assumption. That is why the tiles and the chart can legitimately disagree: one is measured, the other is measured-plus-estimated. The fix in both cases is to record the cost.

## 3. Deploying to Render

[render.yaml](render.yaml) defines the whole deployment — web service plus database — so it can be created as a Blueprint rather than assembled by hand in the dashboard.

1. In Render: **New +** → **Blueprint**, and point it at this GitHub repo
2. Render reads `render.yaml` and proposes a web service and a Postgres database
3. Approve it. `SESSION_SECRET` is generated automatically and `DATABASE_URL` is wired to the database for you — no secrets to copy by hand
4. On the first boot, open the deploy **Logs** and find the generated admin password (see [Your first login](#your-first-login)). It is printed once

Every push to `main` on GitHub redeploys automatically.

**Both must be in the same region** (`render.yaml` sets Frankfurt for both) or they can't use Render's private network.

**Prefer a paid database plan for live data.** Render's free databases are time-limited and are deleted when they expire, which would take your pipeline with them.

### Local development against a separate database

Keep a second, free Render database for development and point `.env` at it. That way local work never touches live data, while still running the same database engine as production — the class of bug that only appears in production is largely avoided this way.

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

Your pipeline lives in **PostgreSQL**, not in a file in this folder.

- **Hosted on Render:** Render takes automatic daily backups on paid plans, with point-in-time recovery. Check the retention window on your plan — free databases are time-limited and are deleted when they expire.
- **Manual backup:** `pg_dump "$DATABASE_URL" > backup.sql` produces a single restorable file. Worth running before anything risky.
- **Never commit `.env`** — it holds the database credentials. It is gitignored, and that is deliberate.
- **Documents attached to deals are inside the database**, in `deal_documents`, not on a disk. That is the reason for the choice: a `pg_dump` or a Render backup captures a deal and its paperwork together, and restoring brings back a matching pair. A separate file store would be a second backup that can disagree with the first. It does mean backups grow with the files — at 50 MB per deal that is slow to become a problem, but worth knowing.

The old SQLite file in `data/` is kept only so [scripts/migrate-from-sqlite.js](scripts/migrate-from-sqlite.js) can copy it across. Once your data is in Postgres, it is dead weight and can be deleted.

## Notes & simplifications (MVP scope)

- Reporting currency is a single app-wide setting (AED by default), not per-deal — simplest approach unless you're regularly dealing in multiple currencies at once.
- Single light theme only, matching the brand's warm/light identity — no dark mode, to avoid rendering the brand in unapproved tones.
- Login sessions are stored in Postgres (`user_sessions` table), so they survive restarts and deploys.
- Deal history is recorded: every create, field-level change and delete, with who and when, in the `deal_history` table and exposed at `/api/deals/:id/history`. It only describes changes made after that feature shipped - history cannot be backfilled.
- The activity log is two tables read as one. `deal_history` holds deal changes with their before and after; `activity_log` holds everything else (sign-ins, account changes, reports run). They are merged by `/api/activity` rather than every event being written twice, which would let the two drift apart. The same backfill caveat applies, and the panel says on screen when recording began so a short log is not mistaken for an idle user.
- `users.last_seen_at` is stamped at most once a minute per person, so "last seen" costs one write a minute rather than one per request.
- Expenses are kept apart from deal cost, and deliberately so. A deal's cost is what that deal's goods cost, and it drives gross profit; expenses are company overheads. Feeding overheads into deal margin would make every deal look unprofitable, so the Expenses tab reports on its own and the dashboard's GP figures are untouched by it. A combined net-profit view would be a separate piece of work.
- Cost is a single figure per deal, not a line-item breakdown — enough for margin reporting, but it won't itemise freight, duty or landed cost separately. Say the word if you need that split out.

## Project structure

```
V Living Trading Tracker.lnk       <- double-click this to run it
Start V Living Trading Tracker.cmd    the launcher the shortcut points at
server.js           Express server + all API routes
db.js               Postgres pool, schema + seed data
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
data/               Legacy SQLite file, kept only for migration
```
