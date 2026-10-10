<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture rules
- Data access uses the browser Supabase client under the `_authenticated` (ssr:false) layout; RLS (has_role admin / own employee row) is the security boundary.
- Worked hours for clock entries are computed by a DB trigger (`compute_record_hours`), so imports and manual entries share one formula.
- First signup becomes admin via `handle_new_user`; later signups are employees linked to employee rows by email.
- File imports are parsed client-side with SheetJS (`xlsx`) for both CSV and Excel.
- Theme is a `.dark` class on <html>, set pre-hydration by an inline head script from localStorage.
- Custom employee categories live in employee_field_defs; values in employees.custom_fields keyed by def id (so renames keep data). Overtime is computed client-side per Mon–Sun week from payroll_settings.
