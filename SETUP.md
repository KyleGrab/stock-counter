# Stock Counter: setup and daily use

A free stock app for the phone. Every metre of cable that leaves the store is tied to a job, and has to come back or be explained.

**Cost:** R0 for software and hosting. You need a phone, a printer and sticker paper.
**Setup time:** about 45 minutes, once.

---

## What's in the folder

| File | What it is | Where it goes |
|---|---|---|
| `index.html`, `app.js`, `core.js`, `sw.js`, `manifest.json`, `icon.svg` | The phone app | GitHub (Part A) |
| `Code.gs` | The link to the Google Sheet | Google Apps Script (Part B) |
| `tests/`, `.github/` | Automatic checks that run on every change | Already on GitHub |

---

## Part A: Put the app online (15 min)

**Do this on a computer.** Uploading files to GitHub is awkward on a phone.

1. Unzip `stock-counter.zip`. You'll get a folder called `stock-app`.
2. Go to **github.com** and create a free account. Your username becomes part of the app link, so pick something sensible (e.g. the business name).
3. Click **+** (top right) → **New repository**.
   - Name: `stock-counter`
   - Choose **Public**. Free hosting needs this. Only the app's code is public; your stock data lives in the Google Sheet, and no PINs or passwords are ever in these files.
   - Click **Create repository**.
4. Click **uploading an existing file**. Open the `stock-app` folder and drag in **these 6 files**: `index.html`, `app.js`, `core.js`, `sw.js`, `manifest.json`, `icon.svg`. Click **Commit changes**.
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
5. The **Execution log** at the bottom shows: `First login -> username: admin   PIN: ......`. **Write the PIN down.** It's a temporary PIN; you'll choose your own the first time you sign in.
   Locked out later? Choose `resetAdmin` in the dropdown and click **Run** to get a new temporary admin PIN.
6. Click **Deploy** (top right) → **New deployment**.
   - Click the gear ⚙ next to *Select type* → **Web app**.
   - *Description*: `Stock Counter`
   - *Execute as*: **Me**
   - *Who has access*: **Anyone** (not "Anyone with Google account", and not "Only myself", or the phone can't connect)
   - Click **Deploy**. Copy the **Web app URL**. It starts with `https://script.google.com/macros/s/` and ends in `/exec`.

> "Anyone" only means the link can be reached. The Sheet refuses every request that doesn't come from a signed-in user with the right role. Still, don't post the link anywhere public.

Get the link to the phone: email or WhatsApp it to yourself, then copy-paste it in Part C.

The Sheet has two hidden tabs, **Users** and **Sessions**. PINs are stored scrambled (hashed), so nobody, not even the owner, can read them. Don't edit these tabs by hand.

Back in the Sheet you'll see new tabs: Items, Jobs, Lines, Moves, Labels, Vans, VanKit.

---

## Part C: Connect and sign in (2 min)

1. Open the app → **Connect our Google Sheet**.
2. Paste the **Web app link** (only needed once per device).
3. Sign in: username `admin`, and the temporary PIN from Part B.
4. Choose your own 6-digit PIN. Only you should know it.

The app is now empty and ready for real stock.

---

## Part C2: Create logins for the team (5 min)

**Admin → Logins → Add a login** for each person, and choose what they can do:

| Access | Give it to | They can |
|---|---|---|
| **User** | Whoever works in the store | Jobs, kitting, scanning, receiving, returns, van counts, stickers. Shelf counts go to a manager for approval |
| **Warehouse Manager** | The person responsible for stock | Everything a User does, plus **Inventory** (approve counts, stock take, adjust, import/export), items and costs, van kits, corrections, reports |
| **Senior Admin** | You / the owner | Everything, including logins and the Google Sheet connection |
| **Viewer** | Owner, accountant | Look at jobs, stock and reports. Can't change anything |

Warehouse Managers and Senior Admins need a 6-digit PIN; Users and Viewers 4 or more.

The app shows a **temporary PIN** once. Give it to the person face to face. They choose their own PIN the first time they sign in.

- Someone leaves: **Logins → tap them → Status: Switched off → Save.** They're signed out on every device immediately.
- Someone forgets their PIN: **Logins → tap them → Reset PIN.**
- 5 wrong PINs locks that login for 15 minutes.
- Every movement is stamped with the signed-in person automatically. Nobody can record under someone else's name.

---

## Part D: First day setup

1. **Items** (Admin → Items, or import them in step 4): add each product. Cable = *Metres*. Panels, inverters, batteries = *Serial number*.
2. **Vans** (Admin → Vans and van kit): add each van, then set the **van kit** (small parts only: connectors, lugs, fuses, ties).
3. **Stickers** (Admin → Stickers): one sticker per **drum, roll, box or shelf bin**. Tap **Print sticker sheet**. Use A4 sticker paper, or plain paper and clear tape.
4. **Receiving a supplier invoice:** type or copy the invoice lines into Excel with a header row, e.g. *Item code, Description, Quantity, Total Ex Vat, Unit*. Select the cells including the header, copy, then **Inventory → Import / export → Add as received**, paste, and enter the **supplier and invoice number**. **Preview** and check that *Total value* equals the invoice subtotal excl. VAT (a cent or two is rounding). Then **Apply**. The same invoice number can't be received twice by accident.
5. **Opening stock, the fast way:** put your current stock in Excel with columns *Item code, Quantity, Landed cost, Name, Unit*. Then **Inventory → Import / export → Add as received**, paste, **Preview**, **Apply**. New items are created automatically.
   For panels and inverters you want tracked by serial, receive them with **Scan → Receive** instead, so each serial is captured.

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
| Every week | **Counts →** each van kit, and the cable drums on the shelves. A User's shelf count goes to **Inventory → Approve** for a Warehouse Manager. Nobody can approve their own count. |
| Stock changes outside a job | Warehouse Manager: **Inventory → Adjust** (damaged, found, short delivery) with a reason, or **Import / export** for a full stock take from Excel. |
| Every month | **Admin/Manage → Missing stock report**: who and which van have missing stock, and which job types used more than quoted. |
| Mistake recorded | A manager opens **Stock → tap the item → Reverse this**, with a reason. Shows in **Corrections log**. |

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
| Forgot my PIN | Ask an admin: **Admin → Logins → Reset PIN**. |
| Admin locked out | In Apps Script, run `resetAdmin` for a new temporary admin PIN. |
| "Changes from another person waiting" | Someone saved work offline and signed out. They must sign in on that phone so the record shows who did it. |
| "No connection" | No signal. Nothing was saved. Try again when there's signal. |
| Changed `Code.gs` later | **Deploy → Manage deployments → ✏ Edit → Version: New version → Deploy.** The link stays the same. |
| Wrong number saved | Movements can't be edited (that's the audit trail). Correct it with a count or a return. |

**Backups:** the Google Sheet keeps its own history (File → Version history). Download a copy monthly: File → Download → Excel.

## No signal?

Keep working. Receiving, kitting, van collection, returns, closing jobs and counts are **saved on the phone** and sent to the Sheet automatically when signal returns. The top of the screen shows how many changes are waiting.

These need signal: **signing in, new jobs, new stickers, new vans, managing logins.**

If another device used the same stock while you were offline, the Sheet refuses the clashing change and the app tells you exactly which one, so nothing goes negative.

**Limits to know:** the app stores its copy of the data on the phone; clearing Chrome/Safari data removes that copy (the Sheet still has everything). Google's free limits are far above what a business this size needs.
