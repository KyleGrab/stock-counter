# Stock Counter: setup and daily use

A free stock app for the phone. Every metre of cable that leaves the store is tied to a job, and has to come back or be explained.

**Cost:** R0 for software and hosting. You need a phone, a printer and sticker paper.
**Setup time:** about 45 minutes, once.

---

## What's in the folder

| File | What it is | Where it goes |
|---|---|---|
| `index.html`, `app.js`, `core.js`, `manifest.json`, `icon.svg` | The phone app | GitHub (Part A) |
| `Code.gs` | The link to the Google Sheet | Google Apps Script (Part B) |
| `tests/` | Checks used while building. Not needed | Nowhere |

---

## Part A: Put the app online (15 min)

**Do this on a computer.** Uploading files to GitHub is awkward on a phone.

1. Unzip `stock-counter.zip`. You'll get a folder called `stock-app`.
2. Go to **github.com** and create a free account. Your username becomes part of the app link, so pick something sensible (e.g. the business name).
3. Click **+** (top right) → **New repository**.
   - Name: `stock-counter`
   - Choose **Public**. Free hosting needs this. Only the app's code is public; your stock data lives in the Google Sheet, and the secret key is never in these files.
   - Click **Create repository**.
4. Click **uploading an existing file**. Open the `stock-app` folder and drag in **these 5 files**: `index.html`, `app.js`, `core.js`, `manifest.json`, `icon.svg`. Click **Commit changes**.
   - ⚠️ Drag the **files**, not the folder. If the files end up inside a `stock-app/` folder on GitHub, the link won't work.
5. Go to **Settings → Pages** (left menu). Under *Branch*, choose **main** and **/(root)**. Click **Save**.
6. Wait 1–5 minutes, then refresh. The link appears at the top of the Pages screen:
   `https://YOURNAME.github.io/stock-counter/`
   (A "404" for the first few minutes is normal. Wait and refresh.)
7. Open the link on the phone and tap **Try it with example data**.
8. Put it on the home screen, so it opens like a normal app:

| Android | iPhone |
|---|---|
| Open the link in **Chrome** | Open the link in **Safari** (not Chrome) |
| Tap **⋮** (top right) → **Add to Home screen** | Tap **Share** (square with arrow) → **Add to Home Screen** |
| First scan: tap **Allow** for the camera | First scan: tap **Allow** for the camera. iPhones may ask again sometimes; tap Allow |

---

## Part B: Create the Google Sheet (15 min)

**Do this on a computer**, signed in to the **business's** Google account, so the business owns the data. The phone doesn't need this account.

1. Go to **sheets.google.com** → **Blank spreadsheet**. Name it `Stock Counter`.
2. Menu **Extensions → Apps Script**. A new tab opens with a code box.
3. Delete everything in the code box. Open `Code.gs` from the folder (with Notepad or TextEdit), copy all of it, paste it in. Click the **save** icon (💾).
4. In the bar above the code, the dropdown next to **Run** shows a function name. Choose **setup**, then click **Run**.
   - Google asks for permission: **Review permissions** → choose the business account.
   - You'll see *"Google hasn't verified this app"*. That's normal for a script you wrote yourself. Click **Advanced** → **Go to Stock Counter (unsafe)** → **Allow**.
   - It only reads and writes this one Sheet.
5. The **Execution log** at the bottom shows: `Your secret key is: ...`. **Copy the key** and keep it private (e.g. in WhatsApp to yourself).
   Lost it? Choose `showKey` in the dropdown and click **Run**.
6. Click **Deploy** (top right) → **New deployment**.
   - Click the gear ⚙ next to *Select type* → **Web app**.
   - *Description*: `Stock Counter`
   - *Execute as*: **Me**
   - *Who has access*: **Anyone** (not "Anyone with Google account", and not "Only myself", or the phone can't connect)
   - Click **Deploy**. Copy the **Web app URL**. It starts with `https://script.google.com/macros/s/` and ends in `/exec`.

> "Anyone" means anyone with the link **and** the secret key. Without the key, the Sheet refuses every request. Never post the key or the link anywhere public.

Get the link and key to the phone: email or WhatsApp them to yourself, then copy-paste on the phone in Part C.

Back in the Sheet you'll see new tabs: Items, Jobs, Lines, Moves, Labels, Vans, VanKit.

---

## Part C: Connect the phone (2 min)

1. In the app: **More → Settings**.
2. Enter your name, paste the **Web app link** and the **secret key**.
3. Tap **Save and connect**. You should see *Connected to the Google Sheet*.

The app is now empty and ready for real stock. The demo data stays separate on the phone.

---

## Part D: First day setup

1. **Items** (More → Items): add each product. Cable = *Metres*. Panels, inverters, batteries = *Serial number*.
2. **Vans** (More → Vans): add each van, then set the **van kit** (small parts only: connectors, lugs, fuses, ties).
3. **Stickers** (More → Stickers): one sticker per **drum, roll, box or shelf bin**. Tap **Print sticker sheet**. Use A4 sticker paper, or plain paper and clear tape.
4. **Opening stock:** walk the store. For each sticker: **Scan → Receive**, enter the quantity on hand and the landed cost. For panels and inverters, scan each serial.

---

## Daily use

```
Quote accepted → New job → Kit the crate → Van collects → Crate back → Close
```

| When | What the storeman does |
|---|---|
| Quote accepted | **Jobs → + New job.** Copy the materials from the quote. |
| Day before the job | Open the job. Pick the kit into a crate (the app adds 10% to cable). Scan panel and inverter serials. Tap **Kit is packed**. Print the crate label and stick it on. |
| Van collects | **Scan** the crate label → **Van collected it**. |
| Short on site | **Scan** the drum sticker → **Extra to job**, with a reason. |
| Crate comes back | **Scan** the crate label. For every line: what's **back in store**, **scrap**, and **used**. Anything left over is **missing** and needs a reason. **Close job**. |
| Every week | **Counts →** each van kit, and the cable drums on the shelves. |
| Every month | **Stock** tab: who and which van have missing stock, and which job types used more than quoted. |

**Shortcut:** stickers hold a web link. Pointing the normal phone camera at any sticker opens the app on that item or job.

---

## House rules (the app only works if these hold)

1. The store is locked. **Only the storeman issues stock.**
2. **All leftovers come back** in the job crate, even short offcuts (they go to scrap and get sold as copper).
3. No buying cable at a hardware store unless the slip is photographed and added to the job as extra.
4. Cable and big items **never** live in the vans. Only the van kit does.

---

## If something goes wrong

| Problem | Fix |
|---|---|
| "Camera blocked" (Android) | In Chrome, tap the icon left of the address → **Permissions → Camera → Allow**. |
| "Camera blocked" (iPhone) | **Settings → Safari → Camera → Allow**, then reopen the app. |
| Serial barcode won't scan (iPhone) | Hold steady, fill the screen with the barcode, or type it in the box. |
| "Wrong secret key" | Check Settings. Run `showKey` in Apps Script to see it again. |
| "No connection" | No signal. Nothing was saved. Try again when there's signal. |
| Changed `Code.gs` later | **Deploy → Manage deployments → ✏ Edit → Version: New version → Deploy.** The link stays the same. |
| Wrong number saved | Movements can't be edited (that's the audit trail). Correct it with a count or a return. |

**Backups:** the Google Sheet keeps its own history (File → Version history). Download a copy monthly: File → Download → Excel.

**Limits to know:** the phone needs signal to save. Use one phone for jobs so job numbers never clash. Google's free limits are far above what a business this size needs.
