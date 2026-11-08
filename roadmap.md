# Roadmap
- [x] Pick design direction (Ledger Glass)
- [x] Cloud backend: employees, time records (clock in/out w/ lunch OR daily hours), roles (admin/employee)
- [x] CSV + Excel import
- [x] Basic pay calc (hours × rate)
- [x] Employee self-view
- [x] Light/night mode toggle
- [x] Fix broken build: spreadsheet reader for the import page was missing
- [ ] Keep the app private: stay unpublished, reachable on one device (Daniel's choice for now)

## Desktop app, data safety and privacy (Oct 27, 2026)
- [x] Fix lost saves: PGlite 0.5.8 didn't write a transaction to storage until the next query (`local.ts`, commit 01f350b)
- [x] Windows desktop app (Electron): `npm run dist:win` → `release/KoPayroll Setup <version>.exe`, per-user install, no admin prompt, unsigned (7a5fca6)
  - Database: `%APPDATA%\KoPayroll\database`. Backups: `%APPDATA%\KoPayroll\Backups`. Uninstalling keeps both.
  - Updating: bump `version` in package.json, `npm run dist:win` (~30 s), run the new installer over the old one.
- [x] Automatic backups every 30 min while data changed, on closing the app, and before database updates; "Back up now" (kept forever); tiered retention: all for 2 days, daily for 30 days, weekly for a year, then monthly (222a5f3)
- [x] Recovery screen when the database won't open: restore a backup, damaged folder kept as `database-damaged-<time>`; crash detection on next start (418762d)
- [x] Sync names each computer; push/pull warnings name who changed the cloud and count differing rows. Needs cloud migration `0010_push_device.sql` (418762d)
- [x] Privacy (b69cf44): backups out of OneDrive; downloaded backup files password-encrypted (no reset if forgotten); everything personal private by default (only department, job title, hire date sync); new categories start private; backups carry private-field choices; first push lists what will upload

## Open
- [ ] **Turn on BitLocker** for C: (Settings → Privacy & security → Device encryption) and keep the recovery key off the laptop
- [x] **Move data into the desktop app** (done by you, Nov 5, 2026)
- [ ] Set up Supabase cloud sync (apply `drizzle/migrations` 0003 … latest in order; see README)
- [x] Edit history / undo for record and profile edits (L7): done Nov 4, 2026 (Edit history page)
- [ ] Optional: auto-update for the desktop app (GitHub Releases); code signing only if handing it to people outside a trusted circle
- [x] **Data encrypted on this device + optional app password** (desktop app; done Oct 31, 2026). The database is encrypted block by block as Postgres writes it (AES-XTS, about 0.1 ms per save), automatic backups are sealed; one random data key, unlocked by Windows for the account when there's no password, or by the password (asked at start), a recovery key shown once, or optionally an emailed code through the cloud account. The unencrypted database and backups convert on first start. Not covered: Chromium's own storage (prefs, templates, cloud sign-in token) and exported files (payroll CSV: names and pay, no ID numbers)
- [ ] At launch (external setup, deferred): test email reset against the real Supabase project: apply migration 0016, and put the code (`{{ .Token }}`) in the "Magic Link" email template
- [x] Sort time records (Time records, Timesheet, Dashboard) and Payroll by date, employee, hours or total pay, with a flip button (done Oct 30, 2026)
- [x] **Copy a week** on Time records (done Oct 31, 2026): a week's shifts for the next 1–8 weeks (or earlier), chosen days and people; skips shifts already there and locked days, asks about days with another record, backs up first, one Ctrl+Z undoes it
- [x] **Typing dates** (done Oct 31, 2026): every date box reads what's typed (1101, 11/1, 11/01/27, Nov 1, today…), shows the date it read, has a calendar button; no year means the nearest one, so future dates work
- [x] **Works offline** (done Nov 1, 2026): the fonts ship with the app instead of loading from Google Fonts; nothing but the cloud features uses the internet
- [x] **Things to check before paying** (done Nov 1, 2026): the Payroll page lists records that look like mistakes (very long day, no break, very short, overlapping, long break, past midnight on a day shift, rate 0, paid 0, resigned, before hire date), each with Open and "It's fine"; limits editable; locking mentions what's still open
- [x] **Names open profiles** (done Nov 1, 2026): every employee name shown (Time records, Payroll, Dashboard, Timesheet, things to check) links to the profile
- [x] **Reports** (done Nov 1, 2026): new tab with charts of pay, hours, overtime, extra pay, people, days worked or pay per hour over any period, per day/week/month/year, split by department, shift or person; bars, stacked, line, area or pie; cards with the previous period; numbers table with CSV. The same chart for one person on their profile, and gross pay for the last 12 weeks on the Dashboard
- [x] **Profile tabs, name cards, comparisons, saving charts** (done Nov 1, 2026): the profile is split into Details · Pay rates · Pay & hours (`?tab=`); resting on a name shows rate, shift and this week; Reports compare with the previous period, the same time last year or chosen dates; charts save as a picture or a PDF with their numbers
- [x] **Row colours and tags on Time records** (done Nov 1, 2026): overtime rows orange by default; things to check, manual pay, weekend, other shift, unlocked, locked, resigned can each colour the row, be a tag, or be off (Colours button)
- [x] Payroll period hint: an empty period says where the nearest records are (Nov 2, 2026)
- [x] Fixed: test databases missing files (`could not open file "base/5/6104"`). Not the app or a force-kill: PGlite dated a new database's files January 1970 (seconds read as milliseconds), and Windows' temp-file cleanup deleted the "old" files in test folders under Temp. The file layer now leaves those dates out and repairs 1970 dates on open (`repairFileDates`) (Nov 2, 2026)
- [x] Database moved to SQLite + SQLCipher (Nov 3, 2026): one encrypted file with a per-page HMAC instead of PGlite's ~1,000 files through our own XTS layer (secure-fs/durable-fs deleted); ~13 MB of memory instead of ~310 MB; opens in ms; `quick_check` at every start; desktop only (`npm run dev` opens the window). Also fixed: a crash in the first seconds after the very first start could lock the data for good (the keyring was saved before Windows' protection key was on disk)
- [ ] Encrypted cloud vault: the cloud keeps only sealed snapshots it can't read; "Edit cloud directly" goes; second computers join with a link code; the recovery key can restore from the cloud (plan Step 6)
- [x] Removed the browser leftovers (Nov 5, 2026; plan Step 5): "Edit cloud directly" (`cloudStore`, `DataMode`) and the header's data-mode badge, Google sign-in, the browser backups branch, the web server build (nitro, SSR entry, server middleware, the Supabase admin client). Kept for cloud sync: push/pull, cloud backups, email sign-in, email key reset, the cloud migrations
- [x] Crash loop and tamper test (plan Step 7, Nov 5, 2026): the app was force-killed at random moments while saving 200 times (scratchpad `crash.mjs`, window hidden with `MERIDIAN_HIDDEN`); every restart passed `integrity_check`, every save the app had reported was there (about 16,000 batches) and no batch was half-saved. Flipping bytes in payroll.db is refused with the recovery screen
- [x] Restored the browser version's backup file into the desktop app (done by you, Nov 5, 2026)
- [x] Side panel on Time records: click a row to see how its pay is worked out and edit it (Nov 1, 2026)
- [x] Right-click menu on Time records rows, and Ctrl+K search (Nov 2, 2026)
- [x] Loading placeholders, progress bars and resizing (Nov 4, 2026): tables, cards and charts show placeholders while loading instead of "no records yet"; a thin bar at the top while data is read; Export several shows "12 of 30", Import its steps. Clicking an employee opens their profile beside the list (drag its edge wider); the Time records panel's width, the page list on the left, chart heights and the template editor's split can be dragged too, and are remembered
- [x] Proper question boxes and an employee menu (Nov 4, 2026): every confirm()/prompt() is now the app's own box (what goes, a red button for deleting, Cancel focused, Escape cancels; "New section…" works again, Electron never showed prompt()); employees can't be deleted with paid days, offered "Mark resigned instead"; each employee row has a ⋯ / right-click menu (open, profile, time records, timesheet, report, resign, delete)
- [x] Reports statistics for any dates (Nov 4, 2026): "Statistics for" the chart's period or chosen dates (type them, or drag across the bars), average per day/week/month/year, choose the cards (total, average, highest, lowest, compared with)
- [x] Sort every table by any column (Nov 4, 2026): a sort button in each column's header (the name still renames it) and "Sort by" listing every column, remembered per table; Time records sorts in the database where it can and in the app otherwise; backups by when or kind
- [x] Copy backups to another drive (Nov 4, 2026): pick a folder (USB stick, another drive) on Sync & backup; after every backup the newest is also saved there as a password-protected backup file that Restore from file opens on any computer, even after this one's disk is wiped; keeps the newest 5–100 (ones you saved yourself always), an unplugged drive is shown and retried, the copy made on closing finishes before the app quits
- [x] Settings window, deductions and net pay, pay runs, edit history (Nov 4, 2026): the gear (or Ctrl+,) opens Settings with Features, Pay rules (overtime, shifts), Checks & colours, Display (theme, breaks, renamed labels), Privacy & security, Backups and Edit history. Deductions (tax, health plan…: fixed per pay period, per week or once, or a percent of gross) give net pay on Payroll, the Timesheet and payslips; pay runs save what each person was paid and lock the period, with payslips showing the paid date and year-to-date totals; both can be turned off. Every change is kept in an edit history (who, when, each field before and after), on its own page and on each profile and record
- [x] Renamed to KoPayroll (Nov 5, 2026): Meridian Payroll is an existing company's name. The data folder moves from `%APPDATA%\Meridian Payroll` to `%APPDATA%\KoPayroll` on the first start
- [x] Bulk "Add deduction" for the selected employees on the Employees page (Nov 5, 2026): asks about people who already have one of that name, one Ctrl+Z takes it back from all
- [x] Removed the unused UI components (Nov 5, 2026): 30 files in src/components/ui and the 21 packages only they used
- [x] Paste rows into Time records (Nov 6, 2026): copy rows in Excel, Google Sheets, a web page, a PDF or an email, press Ctrl+V on Time records (or Paste rows); they open on Import as hours, with its column mapping, duplicate skipping and backup
- [x] Select rows by dragging (Nov 6, 2026) on Employees and Time records, and Shift+click for a range
- [x] Open where I left off (Nov 6, 2026): the app reopens on the last page, with Payroll's period, Time records' filters and Reports' choices
- [x] Saved weekly patterns (Nov 6, 2026): Time records → Patterns…: a usual week and who works it, used to fill any weeks (skips holidays, locked days and shifts already there; one Ctrl+Z)
- [x] Public holidays with your own rules (Nov 6, 2026): Settings → Holidays: a rate for hours worked, paid hours for people who are off ("Add holiday pay"), copy a year to the next
- [x] Edit Time records like a spreadsheet (Nov 6, 2026): "Edit in cells": type into cells, Enter/Tab/arrows, paste blocks from Excel
- [x] Catch likely typos (Nov 6, 2026): a rate 5× higher or lower, a record over 16 hours (AM/PM slips), a new employee with an existing name
- [x] Daily restore check of the newest backup (Nov 6, 2026), in a worker thread, with "Check now" on Sync & backup
- [x] Breaks start at 1 hour (Nov 6, 2026): new records, pattern days, shifts given usual hours
- [x] Fold any box into a bar (Nov 6, 2026): the "Fold" tab on a box's top edge; remembered on this computer; Ctrl+K "Show all folded boxes"
- [x] Shift times fill in by themselves (Nov 6, 2026): new records (and says when a shift has no usual hours), the record side panel (with Put back), patterns
- [x] Ctrl+K finds about 50 features and takes you to the button itself; forgives typos and knows other words (wages, payslip, vacation, tax…)
- [ ] Ideas (Nov 5, 2026): leave and holiday balances, a bank payment file, employer costs on pay runs, a year-end summary per employee
- [ ] Optional: speed — memoize table rows (opening an edit with 500 rows is slow on old PCs); check PGlite updates (0.5.12+)
- [x] Timesheet export with selectable templates (done Oct 28, 2026: your own Excel templates)

## Shifts (Oct 27, 2026)
- [x] Shifts have optional usual hours (start, end, break) on Payroll → Customize → Shifts (schema 8; cloud migration `0011_shift_default_times.sql`)
- [x] Time records: "By shift" buttons select everyone on a shift. When everyone picked shares one shift's usual hours (however they were picked, or via the record's Shift), those show in the clock in/out/break cells. Picking shifts with different hours shows "Add each shift's usual hours" (ticked) with each shift's people and times; the cells go blank while it's on
- [x] "By shift" buttons only pick people the employee search shows (search Spotter, press Day: only day-shift spotters)
- [x] Time records list can be filtered by shift (records set to it, plus ones on the employee's usual shift)
- [x] Department, position and shift filters are checklists: tick several to include any of them, or press Exclude to leave some out; typing `-word` in a search leaves out anyone it matches
- [x] Each shift's times in "Add each shift's usual hours" can be changed before adding (for an unusual day); "Back to usual" undoes it, and they reset after Add

## Requested Oct 27, 2026 (evening)
- [x] Employee IDs can't repeat (any upper/lower case); the add form says who already has it as you type
- [x] Adding a record for someone who already has one that day asks first: Cancel / Add anyway / Skip those, add the rest
- [x] Pay rate history (schema 9, cloud migration `0012_pay_rates.sql`): changing a rate asks "from which day" (or "fix a typo"); earlier days keep the old rate on Payroll, Timesheet, Dashboard and record tables; history listed on the profile. A database trigger keeps old rates even for bulk edits, imports and cloud edits (those start "today")
- [x] Lock paid periods (schema 10, cloud migration `0013_lock_paid_days.sql`): Payroll page → "Lock through <period end>"; records, extra pay and pay rates on or before it can't be added, changed or deleted (the database refuses) until "Change lock…" moves or removes it. Since schema 12 locked days also keep their pay (see below)
- [x] Undo / redo (Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y, and buttons in the header): every change to this device's data this session, each action as one step
- [x] Lock bar on the Time records page too; click a locked record to unlock just it, or select several and unlock them (schema 11, cloud migration `0014_unlock_records.sql`); moving the lock locks them again

## Requested Oct 28, 2026
- [x] Time records: undo/redo, unlock single records, lock bar (see above)
- [x] Time records: bolder column headers that stay at the top while scrolling
- [x] Time records: newest first / oldest first
- [x] Timesheet export: plain Excel or CSV, or the user's own Excel template (upload it, click where each value goes; the file's look is kept). Templates are kept on this device only
- [x] Sudden shutdowns: 135 force-kills in stress tests never damaged the database or lost a commit. Found and fixed a real gap for power cuts: PGlite never flushed writes to the disk (fsync off, and no fsync in its file layer); now every commit is flushed. The one damaged test copy (a missing internal Postgres file) couldn't be reproduced
- [x] Everything under Personal on profiles is treated like ID numbers: off timesheets and the payroll table
- [x] Locked days keep their pay (schema 12, cloud migration `0015_frozen_pay.sql`): rule, multiplier and rate changes don't touch them; unlocking applies the current rules, locking again saves the new pay, Ctrl+Z after an accidental unlock restores the saved pay
