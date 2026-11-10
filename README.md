# Friday 🤖

A personal AI assistant that lives in WhatsApp, powered by Claude. Message it like a friend — privately or in a group —
and it can:

- 💬 **Answer questions** and help with writing, planning, translating, maths… in any language
- 🌐 **Search the web** for current info (news, weather, prices, opening hours) and read links you send
- ⏰ **Set reminders** — one-off ("at 5pm") or repeating ("every weekday at 8"), for you or someone else
- 🗓️ **Do things on a schedule**, in a private chat or a group: send a fixed message ("every morning say Selamat pagi
  to the family group"), or have Friday act then ("every Friday at 5pm, a poll on who's coming to futsal", "every morning
  at 6, today's news"). See [Schedules](#schedules)
- 📄 **Make documents** and send them as files: PDF, Word, Excel, CSV, PowerPoint
- 🎨 **Create and edit pictures** — "draw a birthday card", or send a photo and say "make the background a beach"
- 👀 **Read photos, PDFs and text files** you send, and **understand voice notes** (transcribed for free with Cloudflare;
  Friday answers in text)
- 🧠 **Remember things** you tell it (birthdays, preferences) across conversations
- 📨 **Pass messages** to other people ("tell Sarah I'll be late")
- 🏋️ **Log workouts in Hevy** from a message, a voice note or a photo of a gym notebook, build routines, track body
  weight and coach from your training history (each person links their own Hevy account)
- 📈 **Analyse markets** — stocks, forex, gold and crypto on any timeframe, with a chart, a trading plan and how often
  that plan paid in the past

## How it works

Friday runs on your computer (or a server) and connects to WhatsApp as a **linked device** on a spare number, the same
way WhatsApp Web does. Messages go to Claude (Opus 5.5 by default), which can use the tools above. Everything Friday
stores — conversations, reminders, memories, images — stays in the local `data/` folder.

> Friday uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp library. That's what makes
> it free and flexible, but WhatsApp could ban a number it considers a bot. Use a **spare number**, and don't use
> Friday to message people who haven't messaged it first.

## Setup

**You need:** Node.js 22+, a spare WhatsApp number (a second SIM, or the WhatsApp Business app on any phone),
a [Claude API key](https://console.anthropic.com/settings/keys), and — for pictures — a free Cloudflare account.

```bash
git clone git@github.com:albird97/friday.git
cd friday
npm install
cp .env.example .env
```

Open `.env` and fill in:

| Setting | What to put |
|---|---|
| `ANTHROPIC_API_KEY` | Your Claude API key |
| `ALLOWED_CONTACTS` | Who can use Friday: `Albert=6281234567890,Sarah=6289876543210` (country code, no `+`). **The first person is the admin.** |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | For pictures (free). In the [Cloudflare dashboard](https://dash.cloudflare.com) open **AI → Workers AI → Use REST API**: copy the Account ID and click **Create a Workers AI API Token**. |

### Try it in the terminal first

```bash
npm run chat
```

Chat with Friday right in the terminal — same brain, tools and memory, no phone needed. Files and pictures it makes
are saved to `data/outbox/`. Attach a file with `/attach path/to/photo.jpg what's in this?`.

### Connect WhatsApp

```bash
npm start
```

A QR code appears. On the **spare** phone open WhatsApp → **Settings → Linked devices → Link a device** and scan it.
(Can't scan? Set `PAIRING_NUMBER` to the bot's number in `.env` and you'll get an 8-character code to type in instead.)
You'll see `✅ Connected`. Now message the spare number from your own phone.

The login is saved in `data/whatsapp-auth/`, so you only scan once.

### Keep it running

Friday only works (and only sends reminders) while it's running.

- **On your Mac, always on:** `scripts/macos-service.sh install` runs Friday in the background — it starts at login,
  restarts if it stops, and keeps the Mac from idle-sleeping. Use `scripts/macos-service.sh logs` to watch it (and to
  see the QR code the first time), `restart` after changing `.env`, `uninstall` to remove it.
- **On your Mac, just for now:** `caffeinate -i npm start` in a terminal; Friday stops when you close it.
- **On a Linux server that also runs other apps:** `sudo scripts/linux-service.sh install` sets Friday up under
  `/opt/friday` as a systemd service with its own Node, a 480 MB memory cap and the lowest CPU priority, so it never
  slows the other apps down. It also backs up the database, the WhatsApp login and `.env` every night at 03:30
  (14 days in `/opt/friday/backups`; `backup` runs one now — restore steps are in `scripts/backup.sh`). Put your `.env` in `/opt/friday/app/` (to move from another machine, also copy its
  `data/` folder there and stop the old copy first), then `restart`. `update` pulls new code; `logs` follows the log.
- **On a server with Docker:** `docker compose up -d`, then `docker compose logs -f` to see the QR code the
  first time. Data is kept in `./data`.

## Using Friday

**Private chat:** just message it.

**Groups:** add the bot's number to a group. Friday stays quiet unless someone **@mentions** it, **replies** to one of
its messages, or starts a message with **"Friday,"** (or "hey Friday"). Anyone in the group can talk to it this way
(set `GROUP_ACCESS=contacts` to limit it to your contacts). By default it reads only those messages; with `/context on`
in a group it also reads the rest of the conversation there, so it knows what people were talking about.

Things to try:

- "Remind me to pay the electricity bill on the 25th at 9am, every month"
- "What's the weather in Bandung this weekend?"
- "Make a PDF itinerary for our 3-day Bali trip"
- "Put our monthly budget in an Excel sheet: rent 5jt, food 3jt, …"
- "Draw a cute birthday card for a 6-year-old who loves dinosaurs"
- *(send a photo)* "Remove the people in the background"
- *(reply to a photo in a group)* "@Friday what plant is this?"
- "Remember that Sarah is allergic to peanuts"
- "Tell Sarah I'll be home at 8"
- *(in a group)* "@Friday see who can come to dinner on Saturday at 7" — sends a poll; later "@Friday who's coming?"
- *(admin only)* "Post in the Kongkow group: we meet at 7" — Friday posts it as itself
- *(in a group)* "@Friday every Friday at 5pm make a poll on who's coming to futsal"
- "Analisis BBCA harian dan buatkan trading plan", then "kenapa SL-nya di situ?"

### Schedules

Anyone in the contacts can set these up, in their private chat or in a group (where they run in that group):

- **Reminders** arrive as "⏰ Reminder: …".
- **Scheduled messages** go out exactly as written: "every morning at 6 send 'Selamat pagi semua ☀️'". They cost nothing
  when they go out.
- **Scheduled tasks** are instructions Friday carries out when they come due, as if the person who set them up had just
  asked: "every Friday at 5pm, send a poll on who's coming to futsal", "every weekday at 7, a summary of today's news",
  "on the 1st of every month, ask how much was spent on electricity". Each run is a Claude turn, so it costs like a
  message and counts toward that person's daily limit. Tasks repeat at most hourly, with 10 per person at most.
  A run that finds nothing worth saying (no votes yet, nothing new since what it said last time) sends nothing. They stop when their owner is removed, and they don't run while Friday is stopped (`/stop`).

"What's scheduled?" lists them with their numbers; "cancel #12" stops one. The admin can also set them up for a group
from their private chat: "every Monday at 8, post 'Jangan lupa setor laporan' in the Kantor group".

A message or task that comes due more than an hour late, because Friday was offline, is skipped until its next time.
Reminders are still sent late.

### Commands

| Command | |
|---|---|
| `/help` | What Friday can do |
| `/reset` | Start a fresh conversation (memories and reminders are kept) |
| `/id` | Show this chat's id and your number |
| `/hevy` | Link your own Hevy account (`/hevy <api key>`; `/hevy putus` unlinks it) |
| `/usage` | *(admin)* Claude usage per person, today and this month: estimated dollars (list prices) and tokens |
| `/contacts` | *(admin)* Who can use Friday |
| `/add <name> <number>` | *(admin)* Let someone use Friday and send them a welcome message listing what it can do, e.g. `/add Mom 6281234567890` |
| `/remove <name>` | *(admin)* Remove someone added with `/add` |
| `/katalog` | *(admin)* Put the features in `catalog/items.json` into Friday's WhatsApp Business catalog (adds new items, updates changed ones; WhatsApp reviews each) |
| `/umumkan <text>` | *(admin, private chat)* Send this text as is to every contact, with no sender label, one every few seconds, then report who got it. It goes out at once with no preview. Friday is told about it the next time each person writes, so it understands replies |

Not listed in `/help` (admin only; answers always go to the admin's private chat, so nothing shows in a group):

| Command | |
|---|---|
| `/status` | Uptime, running version, model, memory and database size, active reminders, today's and this month's estimated cost (also in rupiah, `USD_TO_IDR`), and what is paused |
| `/diam [30m \| 2j \| 1h]` | In a group: Friday ignores that group for a while (default 1 hour, at most 7 days; `h` = hari, days) |
| `/bangun` | In a group: end its `/diam` early |
| `/context [on \| off]` | In a group: Friday also reads the messages that don't call it and hands them to Claude with the next one that does, so it follows the conversation. Announced in the group when turned on or off. It keeps the last 50 from the past 24 hours; text only (photos, files and voice notes are noted, not opened). Off deletes what was kept |
| `/switch [semua] [opus \| sonnet \| haiku \| fable \| default]` | Change the Claude model of the chat it's sent in, private or group (in a group the details go to the admin privately and the group gets a one-line confirmation); `default` goes back to the model every chat uses. Fable is the most capable and costs about 2.5× Opus per token. `/switch semua …` changes that default for every chat without its own choice. Always the family's newest version: Friday looks it up now and daily, and tells the admin when the default moves up. Each changed chat continues from a short recap. `/switch` alone shows the current model. People listed in `SWITCH_USERS` can use it in their own private chat |
| `/stop` | Emergency stop: Friday ignores every chat (errand replies included) and skips scheduled tasks until `/lanjut`. Reminders and scheduled messages still go out |
| `/lanjut` | Undo `/stop` |
| `/style [chill \| formal \| funny \| ngeyel \| normal]` | How Friday talks in this chat (group or private). `ngeyel` is devil's advocate: it argues against whatever is said, but still does tasks properly, never invents facts, answers in one voice (no separate "serious" part) and on health, safety, legal and money always argues for the careful side. Takes effect from the next message; `/style` alone shows the current one |
| `/backup` | Send the admin a copy of Friday's database (contacts, memories, reminders, polls, conversations, usage; not the WhatsApp login) |

## Dashboard

The admin can watch Friday in a browser at `https://<domain>/admin` (https://fridayai.my.id/admin), on a phone or a
laptop, in Indonesian, light or dark. It refreshes itself every 30 seconds and shows:

- **Ringkasan:** whether everything is fine, and if not, what needs a look, worst first (WhatsApp disconnected, Claude
  failing, spending past the alert, schedules stuck, memory or disk nearly full, an old backup, failed sign-ins, people
  asking for access). The WhatsApp connection, Claude's last answer, the next schedule and the server at a glance, and
  today's and this month's cost (with the month-end estimate), messages, reply time and people helped.
- **Biaya:** cost per day against the alert line, per person, per model, tokens, web searches and what the cache saved.
- **Aktivitas:** messages per day (private and group), reply times, a day-and-hour map of when Friday is busy (the
  quietest hour is the time to deploy), and which tools Claude uses and how often they fail.
- **Orang** and **Grup:** every contact with today's quota, messages, cost, last activity, linked accounts, own model and
  style; guests who use Friday in groups; website access requests with the `/add` command to copy; every group with its
  context setting, pause, model and schedules.
- **Jadwal**, **Fitur**, **Sistem**, **Keamanan:** upcoming schedules, what's switched on and how much it's used, memory,
  disk, load, version, backups, the WhatsApp connection log and recent errors, and who is signed in to the dashboard.

Charts and tables follow the 7, 30 or 90 days picked at the top. A few actions are there too: stop Friday everywhere
(asked to confirm first) and start it again, both reported to the admin on WhatsApp like `/stop` and `/lanjut`; wake a
group quieted with `/diam`; and sign other browsers out.

It never shows what anyone wrote: no messages, memories, errand briefs, or Google, Spotify, Shopee or Hevy data, and
other people's private schedules appear without their text. To fill the charts Friday keeps a `turns` row per answered
message (when, which chat, whose, how long, whether it worked) and tool calls per day (`tool_usage`, 400 days); recent
errors and the connection log live in memory only. Per-person records (`turns`, the token counts behind the cost
estimates, the daily message counts and spending alerts) are deleted after 180 days, as the privacy page says.

Set the username and password on the server, which also turns the dashboard on (it needs `PUBLIC_URL`):

```bash
sudo /opt/friday/app/scripts/linux-service.sh admin
```

It asks for a username and the password twice (hidden, at least 10 characters) and stores only a scrypt hash in `.env`
(`ADMIN_USER`, `ADMIN_PASSWORD_HASH`). Run it again to change either; that signs every browser out. nginx passes
`/admin` to Friday from the site `linux-service.sh web <domain>` writes, so rerun that once after updating to this
version.

Sign-ins last 7 days of inactivity, 30 at most, in an HttpOnly, SameSite=Strict cookie, over HTTPS only (HSTS). Five
wrong tries from one address (an IPv6 /64 counts as one) block it for 15 minutes, and 30 from anywhere pause sign-ins
from new addresses for 15 minutes; addresses that signed in before still get in. The admin gets a WhatsApp message on
each sign-in, and on blocks the first at once and the rest summed up once an hour. Forms carry a per-session token and
must come from the dashboard's own address.

## Errands with people outside the contacts

People listed in `ERRAND_USERS` can ask Friday, in their private chat, to deal with someone who isn't a contact —
"book a table for 4 at Sate Senayan on Saturday at 7", "ask this shop if they have size 42":

1. If they don't give a number, Friday looks it up (Google Maps listing, website, Instagram bio, Linktree…), checks
   that it's on WhatsApp, and sends the first message straight away (no confirmation code). Friday's code then shows
   them what went out, to which number, and where the number came from.
2. Friday then answers the other side by itself **in their name**, written as them in the first person, within the
   brief: it shares only the details given, and anything else — a deposit, another time, a price — comes back as a
   "❓" question first. It doesn't volunteer that it's an assistant, but if the other side sincerely asks whether
   they're talking to a bot or AI, it doesn't lie: it says it's the person's assistant arranging this for them.
3. Every message both ways is mirrored to their chat, and the outcome arrives as a "📋" summary.

Each errand runs in its own conversation that can only reply to that one number, ask, or finish — it has no web,
files, memories or onehub. Strangers who weren't contacted through an errand are still ignored. Messaging people who
haven't written first is what gets bot numbers flagged by WhatsApp, so keep it to real errands; `ERRAND_DAILY_LIMIT`
(10 by default) caps new ones per day.

## Business back office (onehub)

Friday can also work with onehub, the business's back-office system, for the people listed in `ONEHUB_USERS` — and
only in their private chats (never in groups, where others read along). The one exception: in the groups listed in
`ONEHUB_RESI_GROUPS` (WhatsApp group ids, `…@g.us`), those same people can ask for an order's shipping label, which
Friday sends into the group. Nothing else of onehub works there. Friday never makes a label itself: without
`onehub_resi` it says it can't.

- **Looking things up** ("sales today?", "stock of ABC-12", "unshipped orders as Excel"): Friday writes SQL against
  onehub's database through a PostgreSQL role that can only `SELECT`, and never sees tables or columns that role isn't
  granted (credentials, payroll…). Queries are limited to one statement, 8 seconds and 200 rows.
- **Doing things** (e.g. correcting stock): onehub's internal API lists the actions it allows. When that person asks
  for one, Friday has onehub compute its preview and then runs it straight away (no confirmation code); Friday's code,
  not Claude, sends them onehub's result and summary.
- **Anything else in the panel** (create, edit, delete, any button on any page): `onehub_panel_pages`,
  `onehub_panel_inspect` and `onehub_panel_run` drive onehub's own admin panel pages, forms and actions as that
  person's onehub user, so onehub's permissions, validation and audit log apply as if they had clicked. Ordinary changes
  run at once. Destructive ones (delete, cancel, void, bulk, anything the panel asks to confirm) wait until the person
  replies `YA <code>` with the 4-digit code Friday sends them; Friday's code checks that reply before Claude sees it,
  and Claude never sees the code. Codes expire after 10 minutes and work once.
- **Shipping labels** ("kirim resi 260803ABC"): `onehub_resi` sends the resi PDF of one Shopee or TikTok/Tokopedia
  order as a WhatsApp document, made by the same code as the panel's Cetak Resi button, as that person's onehub user.
- **Notices from onehub** (e.g. a Shopee buyer's chat about to pass the 12-hour reply limit, or a courier handover
  sheet that was just closed): onehub posts them to `http://127.0.0.1:WEB_PORT/onehub/notice` with the same token
  (`ONEHUB_API_TOKEN`), naming who gets them, and Friday sends the text word for word; with a `file`, it goes as one
  WhatsApp document with the text as its caption. Only people in `ONEHUB_USERS` and the groups in
  `ONEHUB_NOTICE_GROUPS` (named by id, `…@g.us`) can receive them; only processes on the server can send (nginx
  doesn't route `/onehub/`, and requests that came through it are refused). The web port starts for this even without
  `PUBLIC_URL`.

## Smart Life devices at home

The admin (and the numbers in `TUYA_USERS`) can ask Friday in their private chat to check or switch the devices in the
home's Smart Life account: "matikan lampu teras", "AC kamar 24 derajat", "lampu mana yang masih nyala?". Never in
groups, where anyone could switch things in the house. Friday lists the devices, reads a device's controls and sends
commands; locks, garage doors and gates are read-only, whatever Claude asks.

Tuya's app SDK only runs inside a phone app, so Friday goes through Tuya's cloud API instead (free, but the trial of
the IoT Core service has to be extended every few months in the console):

1. On [platform.tuya.com](https://platform.tuya.com) create a **Cloud → Development** project ("Smart Home", and the
   data center of your Smart Life account: in the app, **Me → Settings → Account and Security → Region**).
2. In the project, **Devices → Link App Account → Add App Account**, and scan the QR code with the Smart Life app
   (**Me → scan icon**). Copy the linked account's **UID** from that list.
3. Make sure the **IoT Core** service is in the project's authorized services.
4. Put the project's **Access ID** and **Access Secret**, the UID and the data center (`cn`, `us`, `us-e`, `eu`,
   `eu-w`, `in` or `sg`) in `.env` as `TUYA_ACCESS_ID`, `TUYA_ACCESS_SECRET`, `TUYA_UID` and `TUYA_REGION`, then restart.

## Sharing with family and friends

Add people with `/add` (or in `ALLOWED_CONTACTS`). `/add` also greets them on WhatsApp, in Indonesian, with what they can use and an example of each. Only the admin sees who else uses Friday: admin commands always answer in the admin's
private chat (even when sent in a group), and nobody else's conversations include the contact list. Each person gets their own private conversation, reminders and
memories — others can't see them (though as the host, the data lives on your machine). To protect your bill, everyone
except the admin is limited to `DAILY_MESSAGE_LIMIT` messages a day (50 by default). People who aren't contacts are
ignored in private chats; Friday logs their number so you can `/add` them.

The website's "Minta akses" button opens WhatsApp with a sentence already typed. Friday answers that sentence once per
number with a fixed text (no Claude, no cost) and tells the admin, who decides with `/add`.
`ACCESS_REQUEST_DAILY_LIMIT` (20 by default) caps how many it answers per day.

## Google apps

Each contact links their own Google account by sending `/google` in their private chat, and `/google putus` ends it.
YouTube is a second step, `/google youtube`, because Google won't ask for it on the same screen as Drive files.
Friday then works with that person's Calendar, Tasks, Gmail, Drive, Docs, Sheets, Slides, Forms, Contacts and YouTube,
only in their private chat. The account is found from the sender's number, so nobody can reach someone else's.
Everything runs straight away, without confirmation codes; after a change (an email sent, an event added) Friday's code
sends them exactly what was done. Tokens are encrypted with `GOOGLE_TOKEN_KEY`.

On the server, after pointing the domain's DNS at it and creating a Web OAuth client in the Google Cloud project:

```bash
sudo /opt/friday/app/scripts/linux-service.sh web fridayai.my.id
sudo /opt/friday/app/scripts/linux-service.sh google fridayai.my.id
```

## Hevy (workout log)

Anyone who uses [Hevy](https://www.hevyapp.com) with Hevy Pro can link their own account: send `/hevy` in a private
chat, copy the API key from [hevy.com/settings?developer](https://hevy.com/settings?developer), and send
`/hevy <api key>` (or just paste the key). Friday checks the key with Hevy and keeps it
encrypted with `GOOGLE_TOKEN_KEY`, which is all the setup Hevy needs. The key is handled before Claude, so it never
reaches Claude or the chat history. `/hevy putus` forgets it.

Then, in that private chat only:

- **Log a workout** by typing it ("bench 80 kg 3x8, pull ups 3x10 tadi pagi"), in a voice note, or with a photo of a
  notebook page, a whiteboard, a treadmill screen or another app's summary. Friday reads every set, matches each
  exercise to the person's Hevy exercises (gym shorthand like "db", "rdl" or "lat pull down" included) and creates any
  that don't exist yet as custom exercises, in the same save. Weights in pounds are converted to kg.
- **Fix a workout** (a set, the time, the title), **make routines** or a whole program in a folder, and **record body
  weight, body fat and sizes**.
- **Ask about training**: what they did last week, an exercise's history with best weight and estimated 1RM, a
  monthly recap with sets per muscle, or what to lift next.
- **Train together**: "ajak Sarah dan Budi workout bareng" (in a private chat or a WhatsApp group) invites other
  Friday contacts. Each gets a private invite saying who can log for them, who will see it and that it goes into their
  Hevy at the end, and answers `ikut` or `gak ikut` (anyone without Hevy is asked to `/hevy` first). Once everyone has joined, any member can log sets
  for any member, from the group the session started in or their own private chat ("Sarah squat 40 kg 3x10, aku
  60 kg 3x8"). Each exercise is matched against that member's own Hevy, and Friday asks when a name could be several.
  Someone whose sets are logged from another chat gets a private note. The host can invite more people, drop someone
  who isn't coming (which starts it for the rest) or cancel. "Selesai" saves each member's workout into their own Hevy
  and sends them what was saved. If one can't be saved (Hevy unreachable, say), that
  member is told and can ask Friday to save it again within a day. A workout at the same time already in their Hevy
  gets the same warning as above.

Everything runs straight away, without confirmation codes. After each change Friday sends a summary built by its
code from what was saved (times in the person's timezone, every set, new exercises marked ✨, private or public), so
a misread photo shows at once and can be fixed by asking. Because Hevy's API can't delete, the summary warns when
another workout is already in Hevy at the same time (one copy is then deleted in the app), and an edit of a workout
whose privacy Hevy doesn't reveal makes it private and says so. New workouts are private unless the person asks
otherwise.

Hevy's public API can't delete anything, edit or remove custom exercises, or rename folders, and it never says
whether an existing workout is private (Friday remembers what it set and says when it doesn't know). Those things
are done in the Hevy app.

## Spotify

Each contact links their own Spotify with `/spotify`, and `/spotify putus` ends it. Friday reads their top artists and
tracks, liked songs and recent plays, and makes private playlists in their account. Spotify gives new apps no
recommendations, so Claude picks the songs and `spotify_search` turns each pick into a real track; playlists only get
tracks search returned. For a joint playlist, a person allows someone with `/spotify bareng <name>` (and
`/spotify stop <name>` takes it back); only then can that someone's Friday read their taste.

Spotify's development mode needs the app owner to have Premium and allows 5 people, each added by their Spotify email
under User Management in the dashboard. The app's redirect URI is `https://<domain>/oauth/spotify/callback`. Then:

```bash
sudo /opt/friday/app/scripts/linux-service.sh spotify
```

## Shopee shops

Each contact links their own Shopee shop with `/shopee` (`/shopee tambah` for another shop, `/shopee putus` to end it,
with a link to cancel on Shopee's side too). Then they ask in their private chat: "pesanan yang belum dikirim hari ini?",
"uang masuk minggu ini berapa?", "stok kaos hitam tinggal berapa?", "ada retur bulan ini?". Friday only reads: orders,
one order's income after fees, released income, products with price and stock per variation, and returns. It never
writes to Shopee, and asks for no buyer names or addresses.

This is Friday's own Shopee Open Platform app, not onehub's: a shop authorizing onehub's app would reach onehub's
webhooks and back office. Shopee has no `state` parameter, so the redirect `https://<domain>/oauth/shopee/callback/<state>`
carries it, and Shopee rotates the refresh token on every refresh, so both tokens live encrypted in `shopee_shops`.

On open.shopee.com, create the app for serving many sellers (not "Seller In House System", which only takes your own
shops), set the redirect domain to `https://<domain>`, and leave the PII declaration off. Then, on the server:

```bash
sudo /opt/friday/app/scripts/linux-service.sh shopee sandbox
```

Use `shopee` without `sandbox` once Shopee approves the app and gives the live partner ID and key.

## Market analysis

Any contact can ask for technical analysis of Indonesian and US stocks, forex, gold, crypto, or anything Yahoo Finance
lists, on any timeframe from 1 minute to months. Friday sends a chart with the analysis drawn on it (levels, swings,
trend, a price range, entry, stop and targets) and explains it. Follow-up questions work in the same chat.

- **Numbers come from code, not from Claude.** `src/market/` fetches real closed candles, computes everything, and
  Claude only explains the result. Candles are free and need no key: Yahoo for stocks, forex and daily gold, Binance for
  crypto and intraday gold. Yahoo's feed is unofficial, so it can stop working or limit the server for a while. Crypto and
  intraday gold keep working if it does.
- **It doesn't predict direction.** Tested on 32 instruments after costs, classic technical rules didn't beat random
  entries on any timeframe, and shorter timeframes lost more. What did hold was the price range: its 80% band was right
  78-80% of the time. So Friday never promises accuracy.
- **Chance of profit is measured, not estimated.** Each plan shows how often the same setup on the same instrument and
  timeframe reached each target and ended in profit, after costs, with the number of past cases, next to what random
  entries did. The replay uses the plan's exact levels, and a gap past the entry costs what it would really cost. These
  figures hold up: on daily candles, plans printed a 38.5% chance of profit at TP2 and 38.1% of those 11,267 trades got
  there. That says how often a plan pays, not that it pays: the average was still slightly negative.
- **Ready is rare and unproven.** A plan is only called ready on daily candles or longer, when its history beats random
  entries by more than chance. Walked forward over 32 instruments that was about 1 signal in 20, at +0.26R ±0.28 per
  trade: encouraging, not proof. Below daily candles the signals lost money after costs, so no edge is claimed there.
- **Waiting scenarios aren't recommendations.** Most of the time Friday says to wait and gives two stop-order scenarios
  so people have a plan either way. On their own those breakouts lost money on average after costs (-0.05R on daily
  candles), which Friday shows rather than hides.
- **Indonesian stocks** use IDX price steps and lots, and a falling stock reads "avoid", because retail traders can't
  short them.

It is off the website and the catalog (`pending` in `feature-map.json`) until the OJK rules on recommending securities
are checked: POJK 6/2026 requires an investment adviser license for that. Friday tells people it isn't a licensed
adviser, and never decides how much of their money to risk.

## Costs

- **Claude** is pay-as-you-go on your API key (there's no free tier). With Opus 5.5 a typical message costs roughly
  $0.01–0.04, and a document $0.05–0.15. Prompt caching keeps repeat context cheap. To spend less, set
  `FRIDAY_MODEL=claude-sonnet-5-5` (about half) or `claude-haiku-5-5` (much cheaper, less capable). Usage per message
  is printed in the console; your spend is on the [Claude Console](https://console.anthropic.com).
- **Pictures** are free with Cloudflare Workers AI: the free plan gives 10,000 "neurons" a day, about 90 images. If
  the allowance runs out, Friday says so and it resets the next day. (`IMAGE_PROVIDER=gemini` uses Google's Nano
  Banana instead — better at photo edits, but Google charges for every image; there's no free tier.)
- **WhatsApp** linking is free.

## Settings

All settings live in `.env` — see [`.env.example`](.env.example) for the full list (model, thinking effort, timezone,
bot name, limits). Restart Friday after changing them.

## Your data

Everything is in `data/` (not committed to git):

- `whatsapp-auth/` — the WhatsApp login. Delete it to unlink and scan again.
- `friday.db` — conversations, reminders, memories, contacts (SQLite)
- `images/` — photos and pictures, kept 30 days so they can be edited

Back up `data/` to keep everything when moving machines.

## Website

The landing page at https://fridayai.my.id lives in `website/` (Astro and GSAP) with its own `package.json`, so its
dependencies never reach the bot. It reads Friday's features from `catalog/items.json` and their example chats from
`website/src/content/demos.json`, which keeps the WhatsApp catalog and the site one list.

```bash
cd website
npm install
npm run dev     # needs the Node version in website/.nvmrc
npm test        # first time: npx playwright install chromium webkit
```

`scripts/deploy-website.sh` builds on your machine and copies the result to the server, because that server also runs
other production apps. On the server, `sudo /opt/friday/app/scripts/linux-service.sh web <domain>` writes the nginx
site: static files for the page, while `/privacy`, `/oauth/` and the dashboard (`/admin`) go to Friday itself on
`WEB_PORT`.

## Development

```bash
npm test          # unit + end-to-end tests (uses a fake Claude API; no key or cost)
npm run typecheck
npm run dev       # restart on file changes
```

Code map: `src/whatsapp.ts` (WhatsApp connection) → `src/bot.ts` (access, commands, attachments) → `src/agent.ts`
(Claude loop) → `src/tools.ts` (reminders, memory, documents, images, messages). Documents are rendered locally in
`src/docs/`; images go through `src/images.ts`; market analysis lives in `src/market/`. The dashboard is `src/admin/`:
`data.ts` builds a snapshot from the database and `src/monitor.ts`, `view.ts` draws it (no I/O), `server.ts` and
`auth.ts` handle sign-in and requests.
