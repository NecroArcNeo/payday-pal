# Payday Pal

I want to build a payroll app. It will store employee information and store all the paytime work records as a database. It will also be able to accept file imports to add to the database.

## Development

You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

Create a `.env` file in the project root with your Supabase project's URL and publishable key:

```sh
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=<publishable-key>
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<publishable-key>
```

Then:

```sh
npm i
npm run dev        # http://localhost:8080
```

To run a production build: `npm run build`, then `node .output/server/index.mjs`.

Database migrations live in `drizzle/migrations`; `drizzle.config.ts` reads the connection string from `DATABASE_URL`.
