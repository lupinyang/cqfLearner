# CQF Lexicon

A lightweight Feishu web app prototype for collecting CQF vocabulary, generating CQF-context explanations with Zhipu AI, and reviewing words every night.

## What is included

- Add a word with only English word, official CQF module, and optional tags.
- Generate detailed CQF-context Chinese explanation, English explanation, examples, related concepts, confusing terms, and memory hint.
- Review queue with `known`, `vague`, and `unknown`.
- JSON-file storage for the first version.
- Feishu reminder integration scaffold for 22:00 daily reminders.
- No npm dependencies.

## Run locally

```powershell
cd D:\CQF\Jan26\apps\cqf-learner
Copy-Item .env.example .env
npm start
```

Then open:

```text
http://localhost:8787
```

## Configure Zhipu AI

Put your API key in `.env`:

```text
ZHIPU_API_KEY=your_key_here
ZHIPU_MODEL=glm-4.7-flash
```

The server calls:

```text
https://open.bigmodel.cn/api/paas/v4/chat/completions
```

## Configure Feishu reminders

Set these in `.env`:

```text
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_RECEIVE_ID=ou_xxx
FEISHU_RECEIVE_ID_TYPE=open_id
PUBLIC_BASE_URL=https://your-domain.example.com
REMINDER_HOUR=22
REMINDER_MINUTE=0
```

Required Feishu app permissions:

- Send messages as bot / application.
- Access user ID if you want to resolve your own `open_id` from Feishu login later.

For the first version, `FEISHU_RECEIVE_ID` is configured manually.

## Tencent Cloud deployment notes

1. Upload the `apps/cqf-learner` folder to your server.
2. Create `.env` from `.env.example`.
3. Run with a process manager such as PM2.
4. Put Nginx in front and enable HTTPS.
5. Configure the HTTPS URL as the Feishu web app URL.

Example:

```bash
node server.js
```

The built-in reminder checks once per minute and sends at 22:00 in the server's local timezone.

## GitHub and production notes

Do not commit `.env` or `data/store.json`.

Set these environment variables on the target server:

```text
PORT=8787
HOST=0.0.0.0
PUBLIC_BASE_URL=https://cqf.lupinyang.com.cn
TRUST_PROXY=true
ALLOWED_HOSTS=cqf.lupinyang.com.cn,YOUR_LOBSTER_SERVER_HOST:8787
ZHIPU_API_KEY=your_key_here
ZHIPU_MODEL=glm-4.7-flash
ZHIPU_API_URL=https://open.bigmodel.cn/api/paas/v4/chat/completions
```

When Vercel is used only as the public routing layer, expose the app on the server's public port and update `vercel.json`:

```json
{
  "rewrites": [
    {
      "source": "/(.*)",
      "destination": "http://YOUR_LOBSTER_SERVER_HOST:8787/$1"
    }
  ]
}
```

Deployment shape:

```text
cqf.lupinyang.com.cn -> Vercel -> http://YOUR_LOBSTER_SERVER_HOST:8787
```

The Node service must listen on all network interfaces:

```bash
HOST=0.0.0.0 PORT=8787 npm start
```

After deployment, check the origin and the Vercel domain:

```text
http://YOUR_LOBSTER_SERVER_HOST:8787/healthz
https://cqf.lupinyang.com.cn/healthz
```

If you keep `ALLOWED_HOSTS` strict and test the origin by IP, include the IP and port in `ALLOWED_HOSTS`, or send the expected Host header in your check.
