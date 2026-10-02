# Flytrap

A small inbox you run yourself. Mail for your domains is kept, then read in a panel. Any local part is accepted. Missing a letter is the failure that matters.

One Node process, a SQLite file, and the messages on disk. IMAP and sending are not built yet. It is meant to stay this small.

## Run

```bash
git clone https://github.com/wvvu/flytrap.git
cd flytrap
cp .env.example .env
```

Set `API_PASSWORD`, `SESSION_SECRET` (32 bytes or more), and `ACCEPT_DOMAINS`. Then:

```bash
docker compose up -d
```

The panel listens on `127.0.0.1:8080`. Put HTTPS in front of it. SMTP listens on `2525`.

A model can sort the pile. The label is a suggestion, and the letter is stored either way. Set `CLASSIFIER=gemini` and `GEMINI_API_KEYS`, or leave the classifier unset. Keys can also be added in the panel. See `.env.example`.

The preview does not run scripts. Remote images stay unloaded until asked for.

## Develop

```bash
npm install
npm run dev
npm test
```

`node dist/main.js --rebuild` restores SQLite from the raw messages.

## License

[MIT](LICENSE)
