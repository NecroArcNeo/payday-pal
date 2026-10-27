# Payday Pal

I want to build a payroll app. It will store employee information and store all the paytime work records as a database. It will also be able to accept file imports to add to the database.

## How your data is stored

- **On this device, by default.** No account is needed. The data is kept in the browser's storage for this site (`localhost:8080` in development), so use the same browser and address each time.
- **Backups.** The app saves an automatic backup each day you make changes, and before every pull, push or restore. These live on the same device, so also use **Sync & backup → Download backup file** regularly. A file is the only copy that survives the browser's data being cleared.
- **Cloud sync (optional).** Sign in on the Sync & backup page to **push** this device's data to your account, **pull** it onto another device, or **edit the cloud copy directly**. Whatever a push or pull replaces is backed up first, and you're asked before overwriting changes made elsewhere.

## Development

You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
npm i
npm run dev        # http://localhost:8080
```

To run a production build: `npm run build`, then `node .output/server/index.mjs`.

### Desktop app (Windows)

```sh
npm run desktop    # build the pages and open them in the desktop app
npm run dist:win   # build the installer: release/Meridian Payroll Setup <version>.exe
```

The installer is for the current Windows user (no administrator prompt) and isn't code-signed, so a copy sent over the internet shows "Windows protected your PC" once when installing (More info → Run anyway). In the desktop app the database is in `%APPDATA%\Meridian Payroll\database` and the automatic backups are files in `Documents\Meridian Payroll\Backups`. Uninstalling keeps both. To move data from the browser version, download a backup file there and restore it on the desktop app's Sync & backup page.

### Cloud sync setup (optional)

1. Create a `.env` file in the project root with your Supabase project's URL and publishable key:

   ```sh
   SUPABASE_URL=https://<project-ref>.supabase.co
   SUPABASE_PUBLISHABLE_KEY=<publishable-key>
   VITE_SUPABASE_URL=https://<project-ref>.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=<publishable-key>
   ```

2. Apply `drizzle/migrations/0003_local_first_sync.sql` then `0004_shifts_manual_pay.sql`, then `0005_pay_type.sql`, then `0006_gender_nationality.sql`, then `0007_employee_defaults.sql`, then `0008_id_documents_category_sections.sql`, then `0009_record_shift.sql`, then `0010_push_device.sql` to the Supabase database, either with `DATABASE_URL=<postgres connection string> npx drizzle-kit migrate` or by pasting each file into the Supabase SQL editor and running it once, in order. It assigns existing cloud data to the admin account and saves a copy of it in `cloud_backups` first. If anything fails, nothing changes.
3. For "Continue with Google", enable the Google provider in the Supabase dashboard (Authentication → Providers) with a Google Cloud OAuth client, and add your app's URL (e.g. `http://localhost:8080/sync`) to the allowed redirect URLs.

Database migrations live in `drizzle/migrations`; the on-device schema is in `src/lib/db/schema.ts`.
