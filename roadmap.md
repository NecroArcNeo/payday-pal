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
- [x] Windows desktop app (Electron): `npm run dist:win` → `release/Meridian Payroll Setup <version>.exe`, per-user install, no admin prompt, unsigned (7a5fca6)
  - Database: `%APPDATA%\Meridian Payroll\database`. Backups: `%APPDATA%\Meridian Payroll\Backups`. Uninstalling keeps both.
  - Updating: bump `version` in package.json, `npm run dist:win` (~30 s), run the new installer over the old one.
- [x] Automatic backups every 30 min while data changed, on closing the app, and before database updates; "Back up now" (kept forever); tiered retention: all for 2 days, daily for 30 days, weekly for a year, then monthly (222a5f3)
- [x] Recovery screen when the database won't open: restore a backup, damaged folder kept as `database-damaged-<time>`; crash detection on next start (418762d)
- [x] Sync names each computer; push/pull warnings name who changed the cloud and count differing rows. Needs cloud migration `0010_push_device.sql` (418762d)
- [x] Privacy (b69cf44): backups out of OneDrive; downloaded backup files password-encrypted (no reset if forgotten); everything personal private by default (only department, job title, hire date sync); new categories start private; backups carry private-field choices; first push lists what will upload

## Open
- [ ] **Turn on BitLocker** for C: (Settings → Privacy & security → Device encryption) and keep the recovery key off the laptop
- [ ] **Move data into the desktop app**: browser version → Download backup file → desktop app → Restore from file
- [ ] Set up Supabase cloud sync (apply `drizzle/migrations` 0003 … latest in order; see README)
- [ ] Edit history / undo for record and profile edits (L7)
- [ ] Optional: auto-update for the desktop app (GitHub Releases); code signing only if handing it to people outside a trusted circle
- [ ] Optional: app password/lock; payroll CSV exports are plain files (no ID numbers, but names and pay)
- [ ] Optional: speed — memoize table rows (opening an edit with 500 rows is slow on old PCs); check PGlite updates (0.5.12+)
- [ ] Timesheet export with selectable templates (started, interrupted)
