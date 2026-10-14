## REST API
### GET /usage
Returns a plain-text usage guide with command-line and code examples. `GET /`
returns the same guide when the request does not accept `text/html`; browsers
are redirected to `/new`.

### AI agents
`GET /llms.txt` is a Markdown guide for LLMs, `GET /openapi.json` is an OpenAPI 3.1
description, and `GET /.well-known/api-catalog` is an RFC 9727 API catalog that links
both. Every response carries a `Link` header pointing at them, and `GET /robots.txt`
allows these documents while keeping crawlers off paste links (crawling would consume
burn-after-reading pastes).

`POST /mcp` is a stateless MCP server (Streamable HTTP, JSON responses, no
authentication) with the tools `create_paste`, `read_paste`, and `delete_paste`.
Pastes created through it are recorded with the client type `agent`.

```sh
claude mcp add --transport http paste https://paste.bea.sh/mcp
```

### GET /:id
Returns the contents of selected paste (assuming paste exists, otherwise returns 404)

| Name          | Arg   | Type     | Description                                |
| ------------- | :---: | :------: | :----------------------------------------: |
| id            | path  | string   | Unique identifier of the paste             |
| lang          | query | string   | Language (used by the UI, i.e. "markdown") |

### GET /raw/:id
Returns the contents of the selected paste with HTTP `text/plain` header

| Name          | Arg   | Type     | Description                                |
| ------------- | :---: | :------: | :----------------------------------------: |
| id            | path  | string   | Unique identifier of the paste             |

### GET /download/:id
Returns the contents of selected paste with HTTP `application/octet-stream` header

| Name          | Arg   | Type     | Description                                |
| ------------- | :---: | :------: | :----------------------------------------: |
| id            | path  | string   | Unique identifier of the paste             |

### GET /static/:resource
Returns static resources, such as javascript or css files compiled in the binary

| Name          | Arg   | Type     | Description                                |
| ------------- | :---: | :------: | :----------------------------------------: |
| resource      | path  | string   | Resource name (ie. `custom.js`)            |

### POST /
Creates new paste, where input data is expected to be of type:
* `application/x-www-form`
* `application/octet-stream`

| Name          | Arg   | Type     | Description                                |
| ------------- | :---: | :------: | :----------------------------------------: |
| lang          | query | string   | Language (used by the UI, i.e. "markdown") |
| ttl           | query | int      | Expiration time in seconds                 |
| burn          | query | boolean  | Whether to delete the paste after reading  |
| encrypted     | query | boolean  | Used by UI to display "decrypt" modal box  |

The response is the paste URL as text. With `Accept: application/json` it is a JSON
object with `id`, `url`, `raw_url`, `download_url`, `lang`, `size`, `burn`,
`encrypted`, and `expires_at` (ISO 8601, or `null` when it never expires).

### DELETE /:id
Deletes the selected paste from the local database

| Name          | Arg   | Type     | Description                                |
| ------------- | :---: | :------: | :----------------------------------------: |
| id            | path  | string   | Unique identifier of the paste             |
