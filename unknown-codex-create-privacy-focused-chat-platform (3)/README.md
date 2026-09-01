# Unknown

Unknown is a Render-ready, privacy-focused anonymous chat platform. It combines community chat, direct/community messaging foundations, game rooms, reporting, personal-information warnings, and public/private communities in a React web app backed by an Express, Socket.IO, and database-powered server. It uses SQLite locally by default and Render Postgres when `DATABASE_URL` is provided.

Privileged bootstrap accounts are configured only through environment secrets; see `.env.example`. Use `OFFICIAL_ACCOUNT_USERNAME`/`OFFICIAL_ACCOUNT_PASSWORD` for the primary Administrator account. Optional `ADMIN_*`, `OWNER_*`, and `FOUNDER_*` variables create separate high-tier accounts at startup. Never commit real credentials, and rotate any credential that has been exposed.

## Features

- Anonymous usernames and tags; no public real-name requirement.
- Public/private communities with channels, rules, ownership, and memberships.
- Real-time text messaging with replies foundation, reactions, editing/deletion APIs, pinned-message schema, search, mentions-ready text, uploads, and emoji/GIF-link sharing.
- Gaming spaces with game channels, party finder, gaming status events, and future voice/game integrations.
- Privacy and safety copy throughout the product warning users not to share personal information.
- Reports for messages/users, administrator review workflow data, moderation logs, bans/restrictions schema, block/mute schema, and future appeals support.
- Dark/light responsive React interface for desktop and mobile.
- Local SQLite mode for LAN/private-server deployments and free Render Postgres mode for hosted registered servers.

## Running locally

```bash
npm install
npm run dev
```

Open the Vite URL for the client. The API listens on port `3000` by default.

## Local network / registered server data modes

Unknown stores data in a real database. Locally it uses SQLite. On Render, the Blueprint provisions a free Render Postgres database and passes it to the app as `DATABASE_URL`. Choose the visibility/data mode with `DATA_MODE`:

- `DATA_MODE=registered` stores data for a hosted registered server. With `DATABASE_URL`, this uses Postgres; without it, SQLite defaults to `data/unknown.sqlite` unless `DB_PATH` is set.
- `DATA_MODE=local` stores data in a local SQLite file at `data/unknown-local.sqlite` unless you set `DATABASE_URL`, intended for LAN/private-server use where users only see data on that local network or registered private server.

Example LAN server:

```bash
DATA_MODE=local HOST=0.0.0.0 npm start
```

Share `http://YOUR-LAN-IP:3000` with people on the same network.


## One-click Render Blueprint setup

This repo includes a root-level `render.yaml` Blueprint that lets Render automatically create the Unknown web service and a free Render Postgres database. The Blueprint defines the Node runtime, build/start commands, production environment variables, generated JWT secret, generated official account password secret, managed database connection, health check, single-instance web scaling, and commit-based auto-deploys.

To deploy it for free:

1. Push this repository to your Git provider.
2. In Render, choose **New > Blueprint**.
3. Select this repository and confirm the branch.
4. Click **Apply / Deploy Blueprint**.
5. When the first deploy finishes, open the generated `onrender.com` URL.

Important free-tier behavior: chat history and accounts are stored in the free Render Postgres database, which Render currently limits to 1 GB and expires after 30 days unless upgraded. Uploads still use `/tmp/unknown-uploads` on free Render because free web services do not include durable disks, so uploaded files can reset on restart. Render's free web services can also spin down after idle periods, so the next visitor might see a cold start.

For durable production data, upgrade the Render Postgres database before it expires. For durable uploads, upgrade the web service plan, add a persistent disk mounted at `/var/data`, and set `UPLOAD_DIR=/var/data/uploads`.

## Deploying to Render

This repository includes `render.yaml` for free Render Blueprint deployment. Render runs `npm ci && npm run build`, starts `npm start`, creates a free Render Postgres database, injects its connection string as `DATABASE_URL`, sets `OFFICIAL_ACCOUNT_USERNAME=Unknown`, and generates `OFFICIAL_ACCOUNT_PASSWORD` as a secret. Set `DATA_MODE=local` if you are running a private registered server; keep `registered` for a public hosted server.

## Safety notice

Users should avoid sharing personal information, including home addresses, workplace/school information, real names, government names, identification numbers, phone numbers, email addresses, passwords, financial information, or private information belonging to another person. Conversations are intended to remain private; if someone with access reports content, an administrator may review the reported material to determine whether it violates platform rules.
