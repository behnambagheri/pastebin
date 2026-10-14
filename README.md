[![Test and Build][github-workflow]][github-workflow-url]
[![Docker Cloud Build Status][docker-cloud-build-status]][docker-hub]
[![Docker Pulls][docker-pulls]][docker-hub]
[![Docker Image Size][docker-size]][docker-hub]

[docker-hub]: https://hub.docker.com/r/mkaczanowski/pastebin
[docker-cloud-build-status]: https://img.shields.io/docker/cloud/build/mkaczanowski/pastebin
[docker-pulls]: https://img.shields.io/docker/pulls/mkaczanowski/pastebin
[docker-size]: https://img.shields.io/docker/image-size/mkaczanowski/pastebin/latest
[github-workflow]: https://github.com/mkaczanowski/pastebin/workflows/Test%20and%20Build/badge.svg
[github-workflow-url]: https://github.com/mkaczanowski/pastebin/actions

# Pastebin
Simple, fast, standalone pastebin service.

## Cloudflare deployment

The serverless deployment at [paste.bea.sh](https://paste.bea.sh) uses a Cloudflare
Worker and D1 while preserving this project's UI and API. Build, deployment,
verification, and rollback instructions are in [cloudflare/README.md](cloudflare/README.md).

## AI agents

Agents can discover the service through `/llms.txt`, `/openapi.json`, and
`/.well-known/api-catalog`, and use it as an MCP server at `/mcp`
(`claude mcp add --transport http paste https://paste.bea.sh/mcp`). `POST /` returns
JSON with `Accept: application/json`. See [API.md](API.md#ai-agents).

## Docker, Docker Compose, and Kubernetes

The container image `ghcr.io/behnambagheri/pastebin` runs the same code as the
Cloudflare Worker (daisyUI UI, `/usage` guide, and admin area) on Node.js, with
SQLite storage in `/var/lib/paste` instead of D1. CI publishes it for
`linux/amd64` and `linux/arm64` on every push to `master` (`latest`, `sha-…`)
and on version tags. The original Rust server is still built by `Dockerfile.rust`.

```sh
docker run -d --name paste -p 8080:8080 -v paste-data:/var/lib/paste \
  -e PASTE_ADMIN_TOKEN="$(openssl rand -hex 32)" ghcr.io/behnambagheri/pastebin:latest
```

Docker Compose: `docker-compose.yml` uses the same image (or builds it with
`docker compose build`), a named volume, and a hardened runtime:

```sh
echo "PASTE_ADMIN_TOKEN=$(openssl rand -hex 32)" > .env
docker compose up -d
```

Kubernetes with Helm (the chart is in `charts/pastebin` and published to GHCR):

```sh
kubectl create secret generic paste-admin --from-literal=token="$(openssl rand -hex 32)"
helm install paste oci://ghcr.io/behnambagheri/charts/pastebin \
  --set admin.existingSecret=paste-admin --set publicUrl=https://paste.example.com \
  --set ingress.enabled=true --set ingress.hosts[0].host=paste.example.com
```

SQLite allows a single writer, so the chart always runs one replica with a
`Recreate` strategy and a `ReadWriteOnce` volume (kept on uninstall).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PASTE_ADMIN_TOKEN` | empty | Admin sign-in token, at least 32 characters. Empty disables `/admin`. |
| `PASTE_ADMIN_TOKEN_FILE` | empty | Read the token from a file (Docker or Kubernetes secrets). |
| `PASTE_PUBLIC_URL` | empty | Origin for paste links, e.g. `https://paste.example.com`. Empty uses the request host. |
| `PASTE_TRUSTED_HEADERS` | empty | Comma-separated proxy headers to trust for the client IP, e.g. `X-Forwarded-For`. Only set headers your proxy overwrites. |
| `PASTE_DEFAULT_TTL` | `2592000` | Default expiry in seconds (`0` = never). Admin settings override it. |
| `PASTE_LISTEN` | `:8080` | Listen address. |
| `PASTE_DATA_DIR` | `/var/lib/paste` | SQLite database directory. |

### Admin sign-in without Cloudflare

With `PASTE_ADMIN_TOKEN` set, `/admin` redirects to a sign-in page. Entering the
token creates a signed, `HttpOnly`, `SameSite=Strict` session cookie for 12
hours; changing the token signs everyone out. Scripts can call the admin API
with `Authorization: Bearer <token>`. On paste.bea.sh, Cloudflare Access is used
instead, and both methods can be enabled together. Expired pastes are cleaned up
every 15 minutes, and `GET /healthz` reports health.

## Why?
Whenever you need to share a code snippet, diff, logs, or a secret with another human being, a Pastebin service is invaluable. However, using public services such as [pastebin.com](https://pastebin.com) or [privnote.com](https://privnote.com) should be avoided when sharing data that should be available only to a selected audience (e.g., your company or private network). Instead of trusting external providers, host your own Pastebin service and take full ownership of your data.

**There are numerous [Pastebin implementations](https://github.com/awesome-selfhosted/awesome-selfhosted#pastebins) out there — why build another one?**

While the other implementations are great, none satisfied all of these requirements:
* **no dependencies** — one binary is all you need; no Python libs, Ruby runtime, or external databases to set up
* **fast storage** — lightweight, self-hosted key-value store ([RocksDB](https://rocksdb.org/)) built to hold large amounts of data
* **speed** — deployed in a mid-sized company, expect high traffic with low latency requirements
* **reliability** — simple things should just work
* **low cost** — minimal CPU usage
* **CLI + GUI** — easy to use from both ends, still with no deps
* **features:**
    * on-demand AES encryption (client-side, via CryptoJS)
    * syntax highlighting (prism.js)
    * destroy after reading
    * expiry-based auto-deletion
    * dark mode (auto-detects OS preference, manually toggleable)
    * mobile-friendly responsive UI
    * reverse proxy support (respects `X-Forwarded-Host`, `X-Forwarded-Proto`, `Host` headers)

## Implementation
Rust-based pastebin with [RocksDB](https://rocksdb.org/) as storage. Notable implementation details:

* **all-in-one binary** — CSS, JS, and static assets are compiled into the binary via [`include_bytes!`](https://doc.rust-lang.org/std/macro.include_bytes.html); no external files needed at runtime
* **REST API** — add/delete pastes via any HTTP client (see [API.md](https://github.com/mkaczanowski/pastebin/blob/master/API.md))
* **[RocksDB compaction filter](https://github.com/facebook/rocksdb/wiki/Compaction-Filter)** — expired pastes are automatically removed at compaction time
* **[FlatBuffers](https://google.github.io/flatbuffers/)** — paste data serialized with zero-copy access
* **UI** — plain HTML styled with [daisyUI](https://daisyui.com/) on [Tailwind CSS](https://tailwindcss.com/) (prebuilt into `static/style.css` from `cloudflare/style.css`), vanilla JavaScript, and [Prism.js](https://prismjs.com/)
* **encryption** — password-protected pastes are AES encrypted/decrypted in the browser via [CryptoJS](https://code.google.com/archive/p/crypto-js/)

### Plugins
The default configuration enables syntax highlighting via `prism.js`. Additional plugins can be enabled with:

```
--plugins prism <custom_plugin_name>
```

Currently supported:
* [prism.js](https://prismjs.com/) — syntax highlighting
* [mermaid.js](https://github.com/mermaid-js/mermaid) — diagram rendering

## Usage
Requires `rust-nightly` and `clang`/`llvm` (RocksDB build dependency). To skip the build process, use the Docker image.

### Cargo
```
cargo build --release
cargo run
```

### Docker
x86 image:
```
docker pull mkaczanowski/pastebin:latest
docker run --init --network host mkaczanowski/pastebin --address localhost --port 8000
```

ARM images:
```
docker pull mkaczanowski/pastebin:armv7
docker pull mkaczanowski/pastebin:armv8
```

Compose setup:
```
URI="http://localhost" docker-compose up
curl -L "http://localhost"
```

### CLI flags
```
--address <ADDRESS>       Listen address [default: localhost]
--port <PORT>             Listen port [default: 8000]
--uri <URI>               Public base URL (overrides Host header detection)
--uri-prefix <PREFIX>     URL path prefix for reverse proxy deployments
--db-path <PATH>          RocksDB storage path [default: database]
--slug-len <N>            Paste ID length [default: 21]
--ttl <TTL>               Default paste TTL [default: 24h]
--plugins <PLUGINS>...    Plugins to enable [default: prism]
```

### Client
```bash
alias pastebin="curl -w '\n' -q -L --data-binary @- -o - http://localhost:8000/"

echo "hello World" | pastebin
# http://localhost:8000/T9kGrI5aNkI4Z-PelmQ5U
```

`GET /usage` returns a plain-text guide (curl, fish, zsh, bash, and Python
examples) built from `static/usage.txt`, and so does `GET /` for clients that
do not accept HTML, such as `curl http://localhost:8000/`. Browsers are still
redirected to the editor, which has the same guide in its Usage dialog.

## Nginx (optional)
The service serves `/static` files from memory. To offload caching and add compression:

```nginx
map $sent_http_content_type $expires {
    default                    off;
    text/css                   30d;
    application/javascript     30d;
    image/x-icon               30d;
}

server {
    listen      80;
    server_name paste.domain.com;

    gzip on;
    gzip_types text/plain application/xml text/css application/javascript;

    expires $expires;

    location / {
        proxy_pass              http://localhost:8000;
        proxy_set_header Host   $host;
        proxy_set_header X-Forwarded-Host  $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    access_log /var/log/nginx/access.log;
}
```

Setting `X-Forwarded-Host` and `X-Forwarded-Proto` ensures generated paste URLs use the correct public hostname and scheme rather than the internal listener address.

## REST API
See [REST API doc](https://github.com/mkaczanowski/pastebin/blob/master/API.md)

## Benchmark
I used [k6.io](https://k6.io/) for benchmarking the read-by-id HTTP endoint. Details:
* CPU: Intel(R) Core(TM) i7-8650U CPU @ 1.90GHz (4 CPUs, 8 threads = 16 rocket workers)
* Mem: 24 GiB
* Storage: NVMe SSD Controller SM981/PM981/PM983
* both client (k6) and server (pastebin) running on the same machine

### Setup
```
$ cargo run --release

$ echo "Hello world" | curl -q -L -d @- -o - http://localhost:8000/
http://localhost:8000/0FWc4aaZXzf6GZBsuW4nv

$ cat > script.js <<EOL
import http from "k6/http";

export default function() {
    let response = http.get("http://localhost:8000/<ID>");
};
EOL

$ docker pull loadimpact/k6
```

### Test 1: 5 concurrent clients, duration: 15s
```
$ docker run --network=host -i loadimpact/k6 run --vus 5 -d 15s - <script.js

data_received..............: 206 MB 14 MB/s
data_sent..................: 1.6 MB 108 kB/s
http_req_blocked...........: avg=203.98µs min=59.63µs med=97.34µs max=280.74ms p(90)=142.01µs p(95)=161.72µs
http_req_connecting........: avg=60.48µs  min=0s      med=54.22µs max=9.57ms   p(90)=79.67µs  p(95)=93.6µs
http_req_duration..........: avg=4.75ms   min=2.87ms  med=4.66ms  max=27.25ms  p(90)=6.02ms   p(95)=6.59ms
http_req_receiving.........: avg=69.16µs  min=18.54µs med=59µs    max=12.94ms  p(90)=103µs    p(95)=128.14µs
http_req_sending...........: avg=53.21µs  min=18.11µs med=33.01µs max=5.82ms   p(90)=62.68µs  p(95)=166.06µs
http_req_tls_handshaking...: avg=0s       min=0s      med=0s      max=0s       p(90)=0s       p(95)=0s
http_req_waiting...........: avg=4.62ms   min=2.8ms   med=4.54ms  max=20.25ms  p(90)=5.87ms   p(95)=6.36ms
http_reqs..................: 14986  999.062363/s
iteration_duration.........: avg=4.98ms   min=2.96ms  med=4.8ms   max=299.92ms p(90)=6.18ms   p(95)=6.77ms
iterations.................: 14986  999.062363/s
vus........................: 5      min=5 max=5
vus_max....................: 5      min=5 max=5
```

### Test 2: Every 15s double concurrent clients
```
docker run --network=host -i loadimpact/k6 run --vus 2 --stage 15s:4,15s:8,15s:16,15s:32 - <script.js

data_received..............: 654 MB 11 MB/s
data_sent..................: 5.9 MB 98 kB/s
http_req_blocked...........: avg=175.61µs min=56.88µs med=133.4µs max=168.74ms p(90)=175.38µs p(95)=219.87µs
http_req_connecting........: avg=86.58µs  min=0s      med=67.93µs max=34.36ms  p(90)=95.52µs  p(95)=116.89µs
http_req_duration..........: avg=13.29ms  min=2.64ms  med=8.3ms   max=129.12ms p(90)=30.32ms  p(95)=38.67ms
http_req_receiving.........: avg=223.36µs min=18.63µs med=71.91µs max=39.84ms  p(90)=143.88µs p(95)=217.81µs
http_req_sending...........: avg=461.61µs min=17.23µs med=46.8µs  max=62.26ms  p(90)=335.01µs p(95)=857.64µs
http_req_tls_handshaking...: avg=0s       min=0s      med=0s      max=0s       p(90)=0s       p(95)=0s
http_req_waiting...........: avg=12.6ms   min=2.59ms  med=8ms     max=106.26ms p(90)=28.61ms  p(95)=36.55ms
http_reqs..................: 47699  794.982442/s
iteration_duration.........: avg=13.48ms  min=2.75ms  med=8.47ms  max=185.95ms p(90)=30.55ms  p(95)=38.91ms
iterations.................: 47699  794.982442/s
vus........................: 31     min=2  max=31
vus_max....................: 32     min=32 max=32
```

### Interpretation
At first glance, the performance is pretty good. In the simplest scenario (5 concurrent clients), we can get up to `1000 rps` with the p95 response time at `6.59 ms` (`14986` total requests made).

As we add more concurrent clients, the rps drops a bit (`794 rps`) but still provides a good timing (p95 `38.67ms`) with high throughput at `47699` request made in 15s window (3x compared to Test 1).

The CPU utilization is at 100% on every core available and the memory usage is stable at `~13 Mb RSS`.

## Demo
[![Pastebin service demo](https://i.imgur.com/Fv19H71.png)](https://www.youtube.com/watch?v=BG7f61H7C4I "Pastebin service demo")
