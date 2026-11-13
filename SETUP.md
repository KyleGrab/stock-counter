# Stock Counter: setup and daily use

A free stock app for the phone. Every metre of cable that leaves the store is tied to a job, and has to come back or be explained.

**Cost:** R0 for software and hosting. You need a phone, a printer and sticker paper.
**Setup time:** about 45 minutes, once.

---

## What's in the folder

| File | What it is | Where it goes |
|---|---|---|
| `index.html`, `app.js`, `core.js`, `sw.js`, `manifest.json`, `icon.svg`, `vendor/` | The phone app (`vendor/` holds the scanner and QR libraries, kept here so the app loads no code from other websites) | GitHub (Part A) |
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
5. **Choose the admin PIN (easiest way):** go back to the spreadsheet tab and **reload** it. A new menu **Stock Counter** appears (top, next to Help). Click **Stock Counter → Set admin PIN…**, type a 6-digit PIN of your choice, then type it again. That's your admin PIN; no temporary PIN needed.
   - The first time, Google asks for permission again (same steps as above).
   - **Stock Counter → Check admin login** shows whether admin is switched on, locked out, or still needs its own PIN.
   - Locked out or forgot it later? Just use **Set admin PIN…** again. It also clears a lockout.
   - (setup also writes a temporary PIN to the Execution log; you can ignore it if you use the menu.)
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
3. Sign in: username `admin`, and the PIN you set with **Stock Counter → Set admin PIN…** (Part B, step 5).

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

1. **Items** (Admin → Items, or import them in step 4). Anything measured by length defaults to **metres**; **inches** is also available. Countable items (lugs, breakers, panels) are **units**. All costs are **excluding VAT** (15%, claimed back).: add each product. Cable = *Metres*. Panels, inverters, batteries = *Serial number*.
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

## Dev phase: one-tap sign-in (remove before go-live)

While building and testing, the sign-in page has:
- **Demo:** ⚡ buttons for each role (Senior Admin, Warehouse Manager, User, Viewer).
- **Real Sheet:** tick **Remember me on this device** once; afterwards **⚡ Sign in as …** signs in with one tap. The PIN is kept only on that device, never in the code. Turn it off in **My account**, or it switches itself off if the PIN changes.
- The version shows **DEV** while this is on.

**Before staff use the app:** set `DEV_QUICK_SIGNIN = false` at the top of `app.js` (or ask Claude to remove it). Anyone holding a remembered device could otherwise sign in as that person.

## Exception check (Sheet does it, no AI, free)

The Sheet can check itself and list what needs attention in an **Exceptions** tab:

| Rule | Severity | Means |
|---|---|---|
| Job on site, not closed (7+ days) | High if stock is still out there | The leak itself: stock on site never shows as missing until the job is closed |
| Crate packed, not collected (3+ days) | Medium | Stock tied up in a crate |
| Issued over quote / Used over quote / Issued, not on quote | Medium | Beyond quote + cable allowance + 10% |
| Missing after job / Count shortage (last 7 days) | High | Stock written off |
| Repeat missing stock (same installer, 2+ jobs in 30 days) | High | A pattern, not bad luck |
| Van kit shortfall (R500+ in 7 days) | Medium | Van counts book shortfalls as "used", so they never show as missing |
| Low stock, Count waiting for approval (2+ days) | Medium | |
| Correction made (last 7 days) | Low | Check each reason |
| Negative stock | High | Should never happen |

- **Run it:** spreadsheet menu **Stock Counter → Check exceptions now**.
- **Every morning:** **Stock Counter → Turn on daily exception check (6am)**. Google asks you to approve once more (the script now needs permission to run on a timer). Turn it off from the same menu.
- Thresholds are at the top of the rules section in `Code.gs` (`RULES`). The Exceptions tab is never sent to phones.

## Security checklist (all free, about 30 minutes, once)

**How the app is already protected (built in):**
- **No business data on GitHub.** GitHub only holds the app's code. Stock, costs, invoices and logins live only in the Google Sheet. The repository is public, so never commit a Sheet link, PIN, invoice or export to it.
- **The Sheet checks every request itself**, so a tampered phone can't skip a rule: sign-in required, role checks, no negative stock, movements can't be edited or deleted, and size limits per save.
- **PINs:** stored as keyed hashes. The key is in Apps Script **Project Settings → Script Properties** (`PIN_PEPPER`), not in the Sheet, so a leaked or downloaded copy of the Sheet doesn't reveal PINs. 5 wrong PINs locks a login for 15 minutes. 30 wrong PINs across all logins pauses new sign-ins for 15 minutes (phones already signed in keep working; **Set admin PIN…** clears it).
- **Audit log:** a hidden **Log** tab records sign-ins, failed sign-ins, PIN changes and login changes. It is never sent to a phone. Unhide it to look (right-click the tab bar → the tab list).
- **The app page** has a Content Security Policy: it only runs its own code, only talks to Google Apps Script, and refuses injected scripts. Text people type is always shown as text, never run (tested).
- **Never delete `PIN_PEPPER`.** If it's lost, every PIN stops working: use **Stock Counter → Set admin PIN…**, then reset everyone else's PIN in **Admin → Logins**. The same applies if you make a copy of the spreadsheet.

**Google (do these on the Google account that owns the Sheet):**
1. **2-Step Verification on**, ideally with a passkey or the phone prompt (myaccount.google.com → Security). This is the single most important step: whoever controls this Google account controls all the stock data.
2. Run **Security Checkup** (myaccount.google.com/security-checkup) and fix anything it flags. Remove old devices and third-party apps you don't recognise. Keep the "Stock Counter" script.
3. **Don't share the Sheet** with staff. Staff use the app; they never need the Sheet. If the owner or bookkeeper must see it, share as **Viewer**, and in **Share → ⚙** untick **Viewers and commenters can see the option to download, print, and copy**.
4. **Protect the core tabs** from accidental edits: right-click **Moves** → **Protect sheet** → **Only you**. Do the same for **Users**, **Sessions** and **Log**. (The app still writes, because the script runs as you.)
5. **Deployment:** keep **Execute as: Me** and **Who has access: Anyone**. "Anyone" is required for phones to reach it; the PIN sign-in is what keeps people out. Treat the `/exec` link as private: don't post it anywhere public.
6. **Backups:** monthly **File → Download → Excel**, stored somewhere private (not GitHub). Version history covers mistakes in between.
7. Optional, strongest: Google's **Advanced Protection Program** (free, needs two passkeys or security keys) if the owner's account is a likely target.

**GitHub (Settings of the `stock-counter` repository, and your account):**
1. **2FA on your GitHub account** (Settings → Password and authentication), preferably a passkey or authenticator app. Save the recovery codes offline.
2. **Settings → Advanced Security** (or "Code security"): turn on **Secret scanning**, **Push protection**, **Dependabot alerts** and **Private vulnerability reporting**. All free on public repositories. Push protection blocks a commit that contains a password or key.
3. **Settings → Rules → Rulesets → New branch ruleset** for `main`: enable **Restrict deletions** and **Block force pushes**. (Optional: **Require status checks** = the "tests" workflow, so a change that breaks the tests can't go live.)
4. **Settings → Pages:** **Enforce HTTPS** ticked.
5. **Settings → Applications** (your account): the Claude GitHub app should have access to **only** the `stock-counter` repository.
6. Review **Settings → Security log** (your account) now and then for sign-ins you don't recognise.

**Phones:**
- Screen lock on every phone. Turn off one-tap sign-in before go-live (above). A lost phone: **Admin → Logins → switch that login off** (ends its sign-in at once), then switch back on with a new PIN.

**Firewall?** Not needed and not available for free here: there is no server of yours to put behind one. GitHub Pages and Google Apps Script run on GitHub's and Google's own protected infrastructure. The "firewall" for this app is the Sheet's own checks above (sign-in, roles, wrong-PIN limits, size limits). A Cloudflare web firewall would need your own domain name (a yearly cost) and still couldn't sit in front of Google Apps Script, so it adds little.

## If something goes wrong

| Problem | Fix |
|---|---|
| "Camera blocked" (Android) | In Chrome, tap the icon left of the address → **Permissions → Camera → Allow**. |
| "Camera blocked" (iPhone) | **Settings → Safari → Camera → Allow**, then reopen the app. |
| Serial barcode won't scan (iPhone) | Hold steady, fill the screen with the barcode, or type it in the box. |
| Forgot my PIN | Ask an admin: **Admin → Logins → Reset PIN**. |
| Admin locked out or PIN forgotten | In the spreadsheet: **Stock Counter → Set admin PIN…** |
| "Wrong username or PIN" for admin | **Stock Counter → Check admin login**, then **Set admin PIN…** and type the new PIN on the phone (don't copy-paste). |
| "Changes from another person waiting" | Someone saved work offline and signed out. They must sign in on that phone so the record shows who did it. |
| "No connection" | No signal. Nothing was saved. Try again when there's signal. |
| "New sign-ins are paused" | Someone (or something) typed 30 wrong PINs. Wait 15 minutes, or **Stock Counter → Set admin PIN…** to clear it. Then check the hidden **Log** tab to see which usernames were tried. |
| Changed `Code.gs` later | Paste the new code, **save**, then **Deploy → Manage deployments → ✏ Edit → Version: New version → Deploy.** The link stays the same. The phone only uses the new code after this step. Sheet version 1.7 adds one column to Moves (`approvedBy`); it is added automatically on the next save (or by running `setup`), and nothing existing moves. |
| Wrong number saved | Movements can't be edited (that's the audit trail). Correct it with a count or a return. |

**Backups:** the Google Sheet keeps its own history (File → Version history). Download a copy monthly: File → Download → Excel.

## No signal?

Keep working. Receiving, kitting, van collection, returns, closing jobs and counts are **saved on the phone** and sent to the Sheet automatically when signal returns. The top of the screen shows how many changes are waiting.

These need signal: **signing in, new jobs, new stickers, new vans, managing logins.**

If another device used the same stock while you were offline, the Sheet refuses the clashing change and the app tells you exactly which one, so nothing goes negative.

**Limits to know:** the app stores its copy of the data on the phone; clearing Chrome/Safari data removes that copy (the Sheet still has everything). Google's free limits are far above what a business this size needs.
