# Third-party licences

This project builds on prior work. Each project below is credited in the README
and in the source files that draw on it.

---

## vl-downloader — Raiper34

<https://github.com/Raiper34/vl-downloader>

**Used for:** the download queue entity and status model, byte-level progress
tracking, live progress push, and the mounted-downloads-volume deployment shape.

**Diverged:** BullMQ + Redis is replaced with an in-process SQLite-backed worker,
so this stays a single container.

> The author's README asks that the tool not be modified for bulk or simultaneous
> downloading, and that users not be aggressive toward the site. Downloads here
> are serial by construction, with no concurrency setting — see "Why downloads
> are serial" in the README.

```
MIT License

Copyright (c) 2023 Raiper34

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

*The copyright line above reflects the licence as published by the upstream
project. If it is inaccurate, please open an issue and it will be corrected.*

---

## gamarr — JeremiahM37

<https://github.com/JeremiahM37/gamarr>

**Used for:** the platform slug → Vimm `system` map for 18 consoles, the
runtime-loadable source registry pattern with embedded fallback, the
circuit-breaker source-health model, the anchor-regex parse used as our fallback
path, and the general shape of the Vimm download flow.

**Deliberately not copied:** its disabled TLS certificate verification. TLS
verification is left on here; a certificate problem is something to diagnose, not
to switch off.

No licence file was identified in the upstream repository at the time of writing.
Nothing was copied verbatim — the above are design decisions and factual data
(the slug map), reimplemented independently in TypeScript. If the author would
like different attribution, please open an issue.

---

## Runtime dependencies

| Package | Licence | Used for |
|---|---|---|
| [fastify](https://github.com/fastify/fastify) | MIT | HTTP server |
| [@fastify/static](https://github.com/fastify/fastify-static) | MIT | Serving the built client |
| [cheerio](https://github.com/cheeriojs/cheerio) | MIT | HTML parsing |
| [yauzl](https://github.com/thejoshwolfe/yauzl) | MIT | Streaming zip extraction |
| [react](https://github.com/facebook/react) / react-dom | MIT | Web client |

Build-time only: TypeScript (Apache-2.0), Vite (MIT), Vitest (MIT).

## Bundled binaries

`chdman`, from [MAME](https://github.com/mamedev/mame) (GPL-2.0-or-later), is
installed in the Docker image via Debian's `mame-tools` package. It is invoked as
a separate process, not linked into this program.

## The data source

[Vimm's Lair](https://vimm.net/) is not a dependency but is the site this tool
points at. Its `robots.txt` permits crawling. See the README for how this project
tries to be a good guest.
