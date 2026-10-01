# Deploying Chatly

Chatly needs to run on a server that's reachable over the internet so that different
people's phones can all talk to it. Below are two options:

- **Option A — Render (free, recommended):** your app lives on the internet 24/7 with
  a public link you can share with anyone.
- **Option B — Your own computer:** good for testing or chatting with people on your
  home Wi-Fi.

No coding is needed for either option — just follow the steps.

---

## Option A: Deploy free on Render

Render's free plan hosts Chatly at no cost. One caveat to know up front: on the free
plan, Render's disk is wiped whenever the app restarts, so the message database starts
empty after a restart, and the app "sleeps" after ~15 minutes of no use (it wakes up
automatically in about a minute when someone opens it). For a hobby/friends app this is
fine; a paid disk fixes it later if you outgrow it.

### What you need

1. A free GitHub account (https://github.com) — Render deploys from your code there.
2. A free Render account (https://render.com) — sign up with GitHub, it's the easiest.

### Steps

1. **Put Chatly on GitHub.**
   - On GitHub, create a new repository (name it `chatly`, keep it private or public —
     your choice).
   - Upload the whole `chat-app` folder into it (all files: `server.js`,
     `package.json`, the `public/` folder, `README.md`, `DEPLOY.md`, `test/`).
   - The easiest way if you've never used Git: on the repo page click
     **"uploading an existing file"** and drag the files in. (Do NOT upload the
     `data/` folder or `node_modules` — they aren't needed.)

2. **Create the web service on Render.**
   - Go to https://dashboard.render.com → **New +** → **Web Service**.
   - Choose **Build and deploy from a Git repository** → connect your GitHub and pick
     your `chatly` repo.
   - Fill in:
     - **Name:** `chatly` (or anything)
     - **Region:** pick the one closest to you
     - **Runtime:** `Node`
     - **Build Command:** `npm install`
     - **Start Command:** `npm start`
     - **Instance Type:** `Free`
   - Click **Deploy web service**.

3. **Wait for the build** (a few minutes). When it says "Live", you get a public URL
   like `https://chatly-abc123.onrender.com`.

4. **Share that URL with your friends.** Everyone signs up with their own username and
   password, finds each other with the ＋ button, and chats. That's it!

### Updating later

Change code → push to GitHub → Render redeploys automatically. Your database resets on
redeploy (free-plan disk), so treat early versions as fresh starts.

---

## Option B: Run on your own computer (same Wi-Fi)

Good for trying Chatly out, or chatting with family at home. People on *other*
networks won't be able to reach it this way.

### Steps

1. **Install Node.js** (version 22.5 or newer) from https://nodejs.org on your computer.

2. **Open a terminal** in the `chat-app` folder and run:
   ```
   npm install
   npm start
   ```
   You should see: `Chatly listening on port 3000`.

3. **Open it yourself** at http://localhost:3000 and create your account.

4. **Find your computer's local IP address:**
   - Windows: open Command Prompt, type `ipconfig`, look for "IPv4 Address"
     (something like `192.168.1.5`).
   - Mac: System Settings → Wi-Fi → click your network → IP address.
   - Linux: run `hostname -I` in a terminal.

5. **Share** `http://YOUR-IP:3000` (e.g. `http://192.168.1.5:3000`) with anyone on the
   same Wi-Fi. They open it in their phone browser, sign up, and you can chat.

6. **Keep the terminal open** while people are chatting — closing it stops the server.
   Your messages are saved in `data/chatly.db` and survive restarts.

### Notes

- If a friend can't connect, your computer's firewall may be blocking port 3000 —
  allow Node.js through the firewall when prompted, or add an inbound rule for TCP 3000.
- For people *outside* your Wi-Fi to connect, you'd need port forwarding on your
  router — that's fiddly and less secure. Option A (Render) is the better route.

---

## Troubleshooting

- **"npm: command not found"** → Node.js isn't installed (or the terminal was open
  during install — close and reopen it).
- **Port already in use** → something else is on port 3000. Start with
  `PORT=4000 npm start` instead.
- **App sleeps on Render** → free plan behavior; open the URL once and wait ~30–60
  seconds, it wakes up.
- **Database empty after redeploy (Render)** → free-plan disks are ephemeral; this is
  expected. Keep a backup strategy if messages matter.
