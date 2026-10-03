# Assumptions and decisions

These are reasonable defaults for details the brief didn't specify. Each one can be changed.
Items marked **(business rule)** affect the workflow, so please confirm them.

| # | Decision | Why / how to change |
|---|---|---|
| 1 | Every teacher and volunteer belongs to exactly **one team**; every lead belongs to one team. Teachers manage only their team. Super admins have no team and see everything. | Simplest scope model. Can become many-to-many (`team_members`) later without changing lead logic. |
| 2 | **(business rule)** Auto-reassignment only picks volunteers **in the lead's team**. | Keeps leads local. If no one in the team is eligible, the lead goes to the attention queue. |
| 3 | **(business rule)** If no other eligible volunteer exists, the lead is **unassigned** (removed from the current volunteer) and flagged `needs_attention`, rather than left with the volunteer who missed the deadline. | Follows the brief's "unassigned/overdue queue". The alternative is to keep it with them and only alert staff. |
| 4 | **(business rule)** After **3** automatic reassignments a lead goes to the attention queue instead of cycling forever. | `org_settings.max_auto_reassignments`. |
| 5 | **(business rule)** A call logged **after** the deadline but **before** the job runs (it runs every 5 minutes) still counts, and the lead is not reassigned. | The person was contacted, so moving the lead would be counterproductive. |
| 6 | A call by **anyone** (for example the teacher) during the current assignment stops the clock. | The lead was contacted. |
| 7 | Any recorded outcome counts as a qualifying attempt, including "wrong number" (added to the brief's list). | "Wrong number" is still an attempt; the lead status (Invalid Number) is separate. |
| 8 | Closed statuses (Registered, Not Interested, Invalid Number, Do Not Contact, Converted) are never auto-reassigned. | Configurable per status via `lead_statuses.is_closed`. |
| 9 | Leads can be assigned only to **volunteers** (not teachers). | Matches the brief. Easy to widen in `assign_leads`. |
| 10 | Manual assignment ignores availability and workload caps; only inactive volunteers are refused. | Staff can override deliberately. The UI shows a warning. |
| 11 | Volunteers see a lead's full history (calls, notes, earlier assignments) **while it is assigned to them**, and lose access the moment it is reassigned. | Gives new assignees context without exposing other volunteers' current leads. |
| 12 | Volunteers see their own profile and staff profiles in their team, not other volunteers. | Privacy. |
| 13 | Volunteers can opt out of new automatic assignments themselves (`accepting_leads`). | The brief mentions "opted out"; this is a self-service toggle. |
| 14 | Leads are never deleted: they are archived or merged. Assignment history, call attempts, activities and audit logs are append-only, enforced by triggers. | Brief: keep historical records. |
| 15 | Merging keeps both records. The duplicate is archived with `merged_into_id`, and its history stays readable from the kept lead. | No rewriting of append-only history. |
| 16 | Phone numbers are stored in E.164 format. The default country is India (`org_settings.default_phone_country = 'IN'`); the default timezone is `Asia/Kolkata`. | Change both in Settings. |
| 17 | Notification titles and bodies never contain lead names or numbers (lock-screen privacy). Details load inside the app. | Brief §14. |
| 18 | A deactivated user's JWT stops working against the data immediately (RLS returns nothing). Auth-level sign-in is also blocked by the admin-users function (Phase 2). | Defence in depth. |
| 19 | Auth users cannot be hard-deleted while they have a profile (`on delete restrict`). Deactivate instead. | Preserves history and attribution. |
