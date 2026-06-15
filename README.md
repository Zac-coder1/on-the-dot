# On the Dot — your game, ready to launch

This folder is your real website. Below is everything to take it live, written for someone
who has never deployed anything. Do the parts **in order**. Take your time.

You'll touch three websites: **GitHub** (holds the code), **Cloudflare Pages** (puts it
online), and **Supabase** (accounts + saved stats). You already have all three accounts.

---

## What's in this folder (you don't need to edit any of it)

- `src/App.jsx` — the game.
- `src/supabaseClient.js`, `src/storage.js` — the accounts + stats plumbing.
- `supabase-setup.sql` — one thing you'll paste into Supabase.
- `.env.example` — a template for your two secret keys.
- everything else — standard project files.

> Good to know: until you add your Supabase keys, the game still runs perfectly — it just
> saves stats only on the current device (no accounts). So you can deploy first and add
> accounts after. Either order works.

---

## STEP A — Set up Supabase (accounts + stats)

1. Go to your Supabase project.
2. Left sidebar → **SQL Editor** → **New query**.
3. Open the file `supabase-setup.sql` from this folder, copy ALL of it, paste it in, click **Run**.
   You should see "Success". This created your `stats` table with the security lock on it.
4. Left sidebar → **Project Settings** (gear) → **API**. Keep this tab open — you need two values
   from here in Step C and Step D:
   - **Project URL** (looks like `https://abcd1234.supabase.co`)
   - **anon public** key (a long string labeled "anon" / "public")

That's it for now. We'll turn on the actual login buttons in Step E.

---

## STEP B — (Optional) Run it on your own computer first

Skip this if you just want it live. But it's the fastest way to see it working.

1. Install **Node.js** (the "LTS" version) from nodejs.org — it's a normal installer.
2. Open Terminal (Mac) or Command Prompt (Windows), and `cd` into this folder.
3. Make your secrets file: copy `.env.example` to a new file named exactly `.env`,
   then paste in your two Supabase values from Step A.
4. Run these two commands:
   ```
   npm install
   npm run dev
   ```
5. It prints a link like `http://localhost:5173`. Open it. That's your game running locally.
   Press `Ctrl + C` in the terminal to stop it.

---

## STEP C — Put the code on GitHub

1. Go to github.com → top-right **+** → **New repository**.
2. Name it `on-the-dot`, leave it **Public** (or Private — both fine), click **Create repository**.
3. On the next page, click **uploading an existing file**.
4. Drag **everything in this folder** into the upload box. **Important:** do NOT upload the
   `node_modules` folder or your `.env` file if they exist — they're junk/secret. (If you only
   downloaded the files I gave you, you won't have those yet, so you're fine.)
5. Click **Commit changes**. Your code now lives on GitHub.

---

## STEP D — Put it online with Cloudflare Pages

1. Go to your Cloudflare dashboard → left sidebar → **Workers & Pages** → **Create** → **Pages**
   → **Connect to Git**.
2. Authorize GitHub, then pick your `on-the-dot` repository.
3. On the build settings screen, set:
   - **Framework preset:** `Vite`
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
4. Expand **Environment variables (advanced)** and add your two Supabase values:
   - Name `VITE_SUPABASE_URL`  →  Value: your Project URL from Step A
   - Name `VITE_SUPABASE_ANON_KEY`  →  Value: your anon public key from Step A
5. Click **Save and Deploy**. Wait ~1–2 minutes.
6. Cloudflare gives you a live link like `https://on-the-dot.pages.dev`. **Your game is online.** 🎉

> Any time you change the code later, just upload the new files to GitHub — Cloudflare
> rebuilds and updates the live site automatically.

---

## STEP E — Turn on the login buttons

Right now the Sign-in box appears, but the buttons need switching on in Supabase.

### Email login (free, do this first)
1. Supabase → **Authentication** → **Sign In / Providers** → make sure **Email** is enabled.
2. While you're there: to let new sign-ups log in instantly, turn **"Confirm email" OFF**
   (under Email settings). Leave it ON only if you want people to verify via an email link
   first — simpler to start with it OFF, you can switch it on later.

### Tell Supabase your web address (required for logins to work)
1. Supabase → **Authentication** → **URL Configuration**.
2. **Site URL:** your real domain (e.g. `https://yourgame.com`). If the domain isn't connected
   yet, use your `https://on-the-dot.pages.dev` link for now.
3. **Redirect URLs:** add each address people will use, one per line:
   - `https://yourgame.com`
   - `https://on-the-dot.pages.dev`
   - `http://localhost:5173` (only if you did Step B)

### Google login (free)
1. Supabase → **Authentication → Sign In / Providers → Google** → toggle on. It shows a
   **Callback URL** — copy it.
2. Go to Google Cloud Console → create a project → **APIs & Services → Credentials** →
   **Create Credentials → OAuth client ID → Web application**.
3. Under **Authorized redirect URIs**, paste the Callback URL from Supabase. Create it.
4. Copy the **Client ID** and **Client Secret** Google gives you, paste them back into the
   Google provider box in Supabase, and **Save**. Done — the Google button now works.

### Apple login — not included
You chose to skip Apple sign-in (it needs the paid Apple Developer Program, ~$99/year).
Email + Google cover everyone fine. If you ever want to add Apple later, it's a small change
and I can add the button back for you.

---

## STEP F — Connect your domain

1. Cloudflare → **Workers & Pages** → your project → **Custom domains** → **Set up a domain**.
2. Type your domain and follow the prompts. Because your domain is also on Cloudflare, this is
   nearly automatic.
3. After it goes live on your real domain, go back to **Step E → URL Configuration** and make
   sure your real domain is the **Site URL** and is in the **Redirect URLs** list.

---

## You're live

Email + Google sign-in, stats that follow players across devices, a daily challenge, streaks,
and the on-the-dot tracker — all running on your own domain.

**Not included yet (on purpose):** global leaderboards and anti-cheat. Those need a bit of
server code and are the natural "version 2." Ship this, get players, then add competition.

### If something looks broken
- **Buttons say "Accounts aren't set up yet":** your two env vars aren't set in Cloudflare
  (Step D #4). Add them, then redeploy (Cloudflare → Deployments → Retry/Redeploy).
- **Login does nothing / redirects to an error:** your web address isn't in Supabase's
  Redirect URLs (Step E). Add it exactly, including `https://`.
- **Stats don't save when logged in:** re-run `supabase-setup.sql` (Step A) and confirm the
  `stats` table exists under Supabase → Table Editor.
