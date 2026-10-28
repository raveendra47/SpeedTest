# Speedtest

A standalone, dependency-free internet speed test. No accounts, no tracking,
no analytics, no cookies. The only network traffic is random test bytes
exchanged with Cloudflare's public speed endpoints (`speed.cloudflare.com`).
Results are stored only in your browser's local storage.

Measures: download (multi-stream, adaptive sizes), upload (multi-stream),
idle latency, jitter, loaded latency under transfer load, and a
bufferbloat grade A-F. Packet loss is intentionally absent - browsers
cannot measure it honestly.

## Develop

    npm install
    npm run dev      # http://localhost:8080

## Build

    npm run build    # outputs to dist/

## Deploy to GitHub Pages (recommended: Actions)

1. Push this repo to GitHub (branch `main`).
2. Repo Settings -> Pages -> Source: **GitHub Actions**.
3. The included workflow (`.github/workflows/deploy.yml`) builds and
   deploys on every push. Site appears at
   `https://<your-user>.github.io/<repo-name>/`.

## Deploy manually (alternative)

    npm run build
    npx gh-pages -d dist

Then Settings -> Pages -> Source: deploy from branch `gh-pages`, root.

## Privacy

- CSP (meta tag) allows scripts/styles only from this site and network
  requests only to itself and speed.cloudflare.com.
- No third-party JavaScript of any kind is loaded.
- Test uploads contain random bytes, never user files.
- History export/clear buttons give you full control of local data.
