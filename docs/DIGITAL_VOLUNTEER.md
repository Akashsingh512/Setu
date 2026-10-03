# Digital Volunteer (WhatsApp)

A WhatsApp assistant for the organisation's number, built into the CRM.

## How it fits together

```
CRM (Next.js)  ── writes intents ──▶  Supabase (RLS + RPCs)  ◀── service role ──  wa-gateway (Node, Baileys)  ⇄  WhatsApp
```

- **apps/wa-gateway** is an always-on Node process. It is the only part that talks to WhatsApp, using the open-source
  [Baileys](https://github.com/WhiskeySockets/Baileys) library (MIT) to link the number like WhatsApp Web.
- The CRM never talks to WhatsApp. People request things (link, send a reply, change group settings); the database checks
  their Digital Volunteer permission, and the gateway carries out only what was authorised.
- The WhatsApp session is stored in Postgres (`wa_auth_state`, service role only), so the gateway can restart or move
  hosts without scanning a new QR code.

## Important: the risk

Baileys is **not an official WhatsApp API**. Using it is against WhatsApp's terms of service, and WhatsApp can ban the
number. To keep the risk low:

- Link a **dedicated number** (its own SIM), never anyone's personal WhatsApp.
- Enable only the groups you need. The bot ignores every other group: it doesn't even store their messages.
- Outgoing messages are paced (one every ~3.5 s). The inbox only lets you reply to people who wrote first.
- Lead phone numbers are never posted in groups; they go privately to the verified volunteer.
- **Emergency stop:** Digital Volunteer → WhatsApp account → *Turn off now*. Nothing is read or sent until it is turned back on.

## Permissions

Super admins have everything. Anyone else gets only what a super admin ticks on **Digital Volunteer → Operators**.
People use their normal CRM login. Every permission is enforced in the database (`private.dv_can`), not just hidden in the UI.

| Permission | Allows |
|---|---|
| View messages | Inbox and history |
| Reply | Send replies from the number |
| Manage groups | Enable groups, set what the bot may do in each |
| Assign seva leads | Approve seva requests (assigns leads) |
| Update follow-ups | Confirm WhatsApp follow-ups on leads |
| Course responses | Edit course reply templates |
| Announcements | Create and approve scheduled announcements |
| Manage integration | Link/unlink the number, safety switches |
| Reports & audit | Activity and audit logs |

## Running the gateway

### On this computer (testing)

1. Copy `apps/wa-gateway/.env.example` to `apps/wa-gateway/.env` and fill in:
   - `SUPABASE_URL`: your project URL
   - `SUPABASE_SERVICE_ROLE_KEY`: Supabase Dashboard → Project Settings → API keys → *secret / service_role*.
     It has full database access: never put it in the web app or commit it.
2. From the project root: `npm start -w @crm/wa-gateway`
3. In the CRM: **Digital Volunteer → WhatsApp account → Turn on**, then **Link WhatsApp** and scan the QR code from the
   dedicated phone (WhatsApp → Settings → Linked devices → Link a device).

The gateway only works while that terminal is running.

### On Render (always on)

`render.yaml` describes a **Background Worker** (Starter plan, about $7/month). Render's free tier puts services to
sleep, which would drop the WhatsApp connection. In Render: *New → Blueprint*, pick this repository, then set
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` when asked. Any host that can run Node 20.12+ continuously works the same way.

Run **only one gateway at a time**. Two gateways on the same session would fight over the connection.

## Course answers

1. Keyword rules (English, Hinglish, Devanagari) detect course questions and seva requests. When keywords find nothing in
   a question-like message and Bedrock is configured, Claude on Bedrock **classifies** it. It never writes the reply.
2. The reply is built from **Courses** and **Upcoming Programs** using the templates on *Course responses*. Only scheduled,
   not-yet-ended sessions of active courses count. A line whose value is missing is dropped. Nothing is invented.
3. The database decides what happens (`dv_record_intent`):
   - group not enabled / course answers not ticked → nothing
   - **Manual** → flagged for a person
   - **Assisted** (default), or automatic replies paused → suggested reply waits in the inbox for *Approve & send*
   - **Automatic** → sent (a "a volunteer will get back to you" hand-over is never sent automatically)
   - each message gets at most one answer, even if WhatsApp delivers it twice

## Seva requests

"I want to do seva, please share numbers" (English, Hinglish, Hindi) opens a **request** (`dv_seva_requests`).

- **Who:** the sender's WhatsApp number must match an active volunteer's phone in Setu. Otherwise the request waits and
  nothing is shared until an operator picks who it is (*Confirm identity*). Numbers are always sent to the volunteer's
  **Setu** phone number, never to whichever number wrote.
- **Which leads:** unassigned leads of the volunteer's own team; never archived, merged, closed or Do-Not-Contact leads,
  and never a lead that volunteer already held (so someone who missed the 24-hour deadline can't take it straight back).
  Leads that *need attention* go first. Rows are locked (`FOR UPDATE SKIP LOCKED`), so two requests never get the same lead.
- **How many:** the smallest of the person's per-request limit (or a temporary exception), the group's limit, remaining
  open-lead capacity (seva cap and the normal workload cap), and the optional daily / weekly limits. Set on *Seva limits*.
- **Approval:** automatic only if the group is in **Automatic** mode **and** *Assign lead numbers* is ticked **and** the
  requester is recognised and automatic replies aren't paused. Everything else waits on *Seva requests* for someone with the
  *Assign seva leads* permission. Nobody can approve their own request.
- **Delivery:** the details go by **private message** to the volunteer; the group only gets "N lead(s) have been sent to you
  privately". The volunteer also gets a Setu notification (and phone alert). The responsible admin is told about automatic hand-outs.
- **History and undo:** every assignment is a normal one (kind `seva_request`), so the 24-hour rule applies unchanged.
  *Undo assignment* takes back leads nobody has called yet; worked leads stay. Nothing is deleted.
- **Privacy:** lead numbers are not shown on the Seva page. The private message (with numbers) is in the message log, visible
  only to people with *View messages*.

### Approving from WhatsApp

On *Seva limits → Approve from WhatsApp*, choose who should get approval messages (they need the *Assign seva leads*
permission and a phone in Setu). Each request that waits for a decision sends them a private message with a short number,
e.g. *Seva request #12*, and they reply privately to the organisation number:

| Reply | Does |
|---|---|
| `YES 12` (or `approve 12`, `haan 12`) | approve with the normal number of leads |
| `YES 12 3` | approve only 3 |
| `NO 12 reason` (or `decline 12`, `nahi 12`) | decline; the volunteer sees the reason |

A reply only counts if it comes privately from a chosen approver's own WhatsApp (matched to their Setu account), who still
holds the permission at that moment and isn't the requester. Already-decided requests (in Setu or by another approver) are
not decided again. The approver is recorded as the person who assigned the leads, and gets a ✅ / ❌ confirmation.
Anyone else sending "YES 12" is treated as an ordinary message. Unrecognised senders still have to be confirmed in Setu.

### Enabling Bedrock (optional)

Add to `apps/wa-gateway/.env` (or the host's secrets): `AWS_REGION` (e.g. `ap-south-1`), `BEDROCK_MODEL_ID` (a Claude model
or inference-profile id your AWS account has access to, e.g. a Claude Haiku profile), `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`. Restart the gateway. Cost: a few tokens per unclear message only.

## Lead replies (timeline)

Tick *WhatsApp account → Log replies from leads on the lead's timeline*. A private message from a number that matches
**exactly one** live lead is then written to that lead's timeline (with the first 280 characters), and the volunteer holding
the lead gets a notification ("A lead messaged on WhatsApp", no name or number, at most once per lead per 30 minutes).

- It is **never counted as a call**: no call attempt, no first contact, the 24-hour deadline is unchanged.
- Group messages are never linked to leads.
- People with *Update follow-ups* see the lead's open follow-ups at the top of the chat in the inbox and can **Mark done**
  when the messages show the follow-up happened. The timeline records "Follow-up done · confirmed from WhatsApp".

## Announcements

*Digital Volunteer → Announcements* (permission *Announcements*):

1. Write the message, optionally add a poster (JPG/PNG/WebP, up to 5 MB), choose groups and a time (up to 90 days ahead).
   Only groups with *Scheduled announcements* ticked can be chosen; a poster also needs *Posters and links*.
2. **A second person** with the same permission approves it (a super admin may approve their own). They are notified.
3. At the chosen time the gateway posts it to each group, paced like every other message.

Safety: the group's settings are checked again at approval and right before sending (switching a group off stops it);
an announcement **more than 6 hours late** (gateway or Digital Volunteer was off) is not sent; *Cancel* stops every group
not yet sent. Posters are stored in the private `dv-posters` storage bucket created by the migration.

## Reports and checks

- **Overview → Checks**: gateway running, number connected, switched on, groups enabled, no failed messages, nothing
  waiting more than a day, no announcement waiting for approval. Each failing check links to where to fix it.
- **Reports** (permission *Reports & audit*): messages per day, what people asked, how replies went out (automatic /
  approved / written by people), seva outcomes, busiest groups, and the Digital Volunteer audit log. Counts only: no
  message text or phone numbers, so this permission doesn't let someone read chats.

## Deployment checklist

1. Apply all migrations in `supabase/migrations` to the Supabase project (in order).
2. Web app and gateway: one AWS Lightsail server runs both, with HTTPS and automatic updates from GitHub. Follow
   [DEPLOY_LIGHTSAIL.md](DEPLOY_LIGHTSAIL.md). Add the server's address in Supabase → Authentication → URL Configuration.
3. Run **one** gateway only: stop the one on your PC before starting it on the server (`setu gateway-on`).
4. In Setu: grant operators, link the number, turn Digital Volunteer on, enable groups. Then open **Overview → Checks**:
   every line should be ✓.
5. Send a test message from another phone to an enabled group and check it appears in the Inbox.

## What is built

| Phase | Status |
|---|---|
| 2: Link by QR, status, safety switches, operators, groups and permissions, inbox, manual replies | ✅ built |
| 3: Course answers from Courses / Upcoming Programs (keywords + optional Amazon Bedrock), manual/assisted/automatic modes, editable templates, suggestions in the inbox | ✅ built |
| 4: Seva requests → lead assignment within limits, numbers sent privately, approval, undo | ✅ built |
| 5: Lead replies logged on the lead timeline (never counted as calls), follow-ups confirmed from the inbox | ✅ built |
| 6: Scheduled announcements with posters, second-person approval | ✅ built |
| 7: Health checks, reports, audit log, deployment checklist | ✅ built |
