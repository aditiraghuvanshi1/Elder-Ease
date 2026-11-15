# ElderEase

ElderEase helps older people in India stay on top of their medicines and get everyday help from people nearby.

- **Elders** see today's doses and tap *Taken* or *Skip*. They can call 108, 112 or 102 in one tap, send an SOS to family, keep a health log and post requests for help.
- **Caretakers** manage the medicine schedule and appointments, and can mark doses for the elder.
- **Family members** follow along (view only) and get an email if a dose is missed.
- **Volunteer helpers** take on requests such as fetching medicine or setting up a phone, and earn Mitra Coins.

The interface is available in English, Hindi, Tamil, Telugu and Bengali, with a larger-text mode and voice input.

## Live demo

**https://aditiraghuvanshi1.github.io/Elder-Ease/**

This GitHub Pages version runs entirely in your browser. Try it with the demo cards on the login page:

| Demo account | Email | Password |
|---|---|---|
| Elder | `elder@demo.in` | `Elder@123` |
| Volunteer helper | `helper@demo.in` | `Helper@123` |

What works here:
- the elder pages: emergency numbers, SOS, medicine checklist, health log, doctor summary
- requesting help, and the helper's request board with chat and Mitra Coins
- all five languages and the larger-text mode

GitHub Pages can only show websites; it cannot run the ElderEase server. So the Care Circle, the shared medicine schedule, email reminders and password reset are not available in this demo. To see them, run the full app (next section) or deploy it to Render (see [Deploying](#deploying)).

Data in this demo is saved only in your browser on your device. Nothing is sent anywhere.

## Run the full app on your computer

You need **Node.js 22.13 or newer**.

```bash
npm install
npm run dev        # starts on http://localhost:3000 with demo accounts and 14 days of history
```

On Windows PowerShell, use `$env:SEED_DEMO=1; npm start` instead of `npm run dev`.

Open http://localhost:3000 and tap a demo card on the login page:

| Demo account | Email | Password | Lands on |
|---|---|---|---|
| Elder | `elder.demo@elderease.in` | `Elder@123` | Home page with today's doses |
| Caretaker | `caretaker.demo@elderease.in` | `Care@1234` | Care Circle (can edit) |
| Family | `family.demo@elderease.in` | `Family@123` | Care Circle (view only) |
| Volunteer helper | `helper@demo.in` | `Helper@123` | Request board (browser-only account) |

To see live sync, sign in as the elder in one window and as the caretaker in another (use a private window). When the caretaker adds a medicine, it appears on the elder's screen within a second. When the elder taps *Taken*, the caretaker sees it straight away.

Without email settings, nothing is actually sent. Every email is saved and shown under **Care Circle → Circle & settings → Recent notifications**.

## Features

**Medicines and adherence**
- A shared medicine schedule: daily times and days of the week, managed by the elder or a caretaker.
- One record per scheduled dose: *taken*, *skipped* or *missed*, with who marked it and when. Every change is kept.
- The elder's home page lists today's doses with *Taken* and *Skip* buttons, and rings an alarm at each dose time while the page is open.
- An adherence summary for 1, 7, 14 or 30 days, by day and by medicine.

**Emails, sent by the server on a schedule**

| Email | When | Goes to |
|---|---|---|
| Upcoming dose | 15 minutes before | the elder |
| Missed dose | 60 minutes after, if not marked | the elder and the whole care circle |
| Appointment | about 24 hours and 2 hours before | the elder and the whole care circle |
| Summary | every evening, or Sunday mornings (each person chooses) | caretakers and family |
| Password reset / password changed | when asked / after a reset | that person |

Each email is sent once, even after a restart. Failed sends are retried.

**Care circle and access**
- The elder creates one-time passcodes (single use, valid 48 hours) for a caretaker or a family member.
- Caretakers can view and edit; family members can only view. The server checks this on every request.
- The elder can remove anyone, and anyone can leave.

**Accounts**
- One login page for everyone.
- Password reset by email.
- Download all your data as a file, or delete your account (Care Circle → Circle & settings → Your data).

**Everyday help (browser-based)**
- Elders post requests; nearby helpers offer to help. The elder accepts before the helper sees their address.
- Private chat, ratings, Mitra Coins and a leaderboard.
- Health log for blood pressure, sugar, mood and symptoms, with a calendar, trends and a printable doctor summary.

## Email setup

Set **one** of these in the environment (see `.env.example`):

| Option | Settings | Notes |
|---|---|---|
| Gmail or any mail server | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Quickest way to email anyone in a demo. For Gmail, turn on 2-Step Verification, create an App Password, and use `smtp.gmail.com` on port `587`. |
| Resend | `RESEND_API_KEY`, `MAIL_FROM` | Delivers only to your own address until you verify a sending domain. |
| SendGrid | `SENDGRID_API_KEY`, `MAIL_FROM` | |

Also set `APP_URL` to the site's public address, because email links and password-reset links use it.

## Deploying

### GitHub Pages (website only, browser-only mode)

This repository publishes the `site/` folder to GitHub Pages automatically, using `.github/workflows/pages.yml`.

To set it up in your own copy:
1. Go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**. If it's left on "Deploy from a branch", Pages shows this README instead of the site.
3. Open the **Actions** tab and wait for "Publish site to GitHub Pages" to show a green tick. If it hasn't started, click it and choose **Run workflow**.
4. Your site is at `https://<your-username>.github.io/<repository-name>/`.

Every commit to `main` republishes the site within a couple of minutes. If your branch is called `master`, change `[main]` to `[master]` in the workflow file.

### Render (full app: server, emails, Care Circle)

The Node server serves both the website and the API, so deploy it as one web service.

1. Sign in at render.com with your GitHub account.
2. Choose **New → Blueprint** and pick this repository. Render reads `render.yaml`.
3. In the service's **Environment** settings, set:
   - `APP_URL` (the address Render gives you, for example `https://elderease.onrender.com`)
   - your email settings (see [Email setup](#email-setup))
   - `CRON_SECRET`, if you add an outside cron (see below)
4. Open the address Render gives you. Everything works there, including the Care Circle demo accounts if `SEED_DEMO=1` is set.

Free hosting plans pause when idle and lose the database file on redeploy. To fix this:
- Add a free cron (for example cron-job.org) that calls `POST https://YOUR-APP/api/cron/tick` every minute with the header `x-cron-secret: <CRON_SECRET>`. This keeps reminders on time.
- Keep `DB_FILE` on a persistent disk for real data.

### Other static hosts (Netlify, Vercel, Cloudflare Pages)

Publish only the `site/` folder. As on GitHub Pages, the login page detects that there is no server and uses browser-only accounts. Extra security headers for these hosts are in `site/_headers` and `site/vercel.json`. GitHub Pages ignores those files, but every page already carries its main security policy in a `<meta>` tag.

## Project layout

```
.github/workflows/
  pages.yml           publishes site/ to GitHub Pages on every commit
site/                 the website (plain HTML, CSS and JavaScript, no build step)
  index.html          login, sign up, forgotten password
  adult*.html         elder pages: home, request help, health log, doctor summary
  care.html           Care Circle for elders, caretakers and family
  helper.html         volunteer request board
  reset.html          choose a new password from the emailed link
  elder-sync.js       connects the elder's home page to the server
  fonts/              self-hosted fonts (must stay in this folder)
server/
  src/app.js          HTTP server and API routes
  src/db.js           SQLite schema
  src/worker.js       scheduler: dose, missed-dose and appointment emails, summaries
  src/digest.js       adherence summaries
  src/mailer.js       Resend, SendGrid or SMTP
  src/templates.js    email text
  src/seed.js         demo data
  test/               automated tests
BACKEND.md            API reference, scheduler and email details, deployment notes
SECURITY.md           security review and what was changed
```

## Tests

```bash
npm test
```

There are 16 tests. They cover:
- sign-up and login rules, lockouts
- passcodes and roles
- medicine editing and dose history
- each reminder email and summary, each sent once
- live sync
- password reset
- data export and deletion
- delivery through a real local mail server

## Security

In short:
- **Passwords** are hashed with scrypt.
- **Sessions** use `HttpOnly`, `SameSite=Strict` cookies, stored only as hashes.
- **Every page** has a strict Content Security Policy with no inline scripts.
- **Server data** is reached only through role-checked API routes.
- **Rate limits** apply to login, sign-up, passcodes and password resets.

See `SECURITY.md` for the full review.

## Known limits
- ElderEase is a reminder tool, not medical advice or an emergency service. In an emergency, call 112.

## Fonts

Newsreader and Atkinson Hyperlegible, under the SIL Open Font License (license files in `site/fonts/`).
