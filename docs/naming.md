# Library naming

How downloaded files are named and where they land.

## The convention

Files follow **No-Intro / Redump style**:

```
Title (Region) (Version).ext
```

This is not an invention. It is what the scraper ecosystem — EmulationStation,
Skraper, RetroArch playlists, LaunchBox — matches against. A library named any
other way gets identified badly or not at all.

The title, region and version all come from the catalogue, captured at match time
rather than guessed from a filename afterwards. That is a quiet payoff from
resolving names before downloading anything.

## Template tokens

Set with `NAMING_TEMPLATE`. The default is `{title} ({region})`.

| Token | Example | Notes |
|---|---|---|
| `{title}` | `Silent Hill 2` | The canonical Vault title |
| `{region}` | `USA` | Primary region; multi-region releases use the first flag |
| `{version}` | `2.01` | As listed on the Vault |
| `{platform}` | `ps2` | Our platform slug |
| `{vaultId}` | `9250` | Useful if you want the ID embedded |
| `{disc}` | `1` | Only meaningful for multi-disc releases |

**Empty tokens collapse cleanly.** A game with no listed region does not become
`Okami ().iso` — the empty bracket group is removed, giving `Okami.iso`.

Settings shows a live preview over three worked examples, including a multi-disc
one, so you can see what a change does before applying it to 400 games.

### Worked examples

With `NAMING_TEMPLATE={title} ({region})`:

| Catalogue entry | Result |
|---|---|
| Silent Hill 2 · USA · v2.01 | `Silent Hill 2 (USA).chd` |
| Okami · *no region* · v1.01 | `Okami.chd` |
| Final Fantasy VII · USA · 3 discs | `Final Fantasy VII (USA)/` containing three discs + an `.m3u` |

With `NAMING_TEMPLATE={title} ({region}) ({version})`:

| Catalogue entry | Result |
|---|---|
| Silent Hill 2 · USA · v2.01 | `Silent Hill 2 (USA) (2.01).chd` |

## Illegal characters

Characters no common filesystem accepts are **replaced, not stripped**, so titles
stay readable:

| Input | Output |
|---|---|
| `Ratchet & Clank: Up Your Arsenal` | `Ratchet & Clank - Up Your Arsenal` |
| `Where/When?` | `Where-When` |

Two more rules exist to keep libraries portable:

- A trailing dot or space is legal on POSIX and **silently dropped by Windows**,
  which makes a library subtly non-portable. Both are trimmed.
- Windows reserves `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`
  regardless of extension. Those get an underscore prefix.

## Multi-track vs multi-disc

These are different things, and conflating them destroys disc images.

**Multi-track** is one disc ripped as several files — commonly `Track 01.bin`,
`Track 02.bin` and a single `.cue`. Those tracks get a `(Track N)` suffix:

```
Final Fantasy VII (USA)/
  Final Fantasy VII (USA) (Track 1).bin
  Final Fantasy VII (USA) (Track 2).bin
  Final Fantasy VII (USA).cue
```

Naming both bins after the game would collapse them onto one filename and the
second would silently overwrite the first — the cue would then reference the
survivor twice, and the game would not boot. If a collision is ever detected, the
organizer stops rather than overwriting.

**Multi-disc** is one game spanning several discs. Each gets a `(Disc N)` suffix,
the set gets its own folder, and an `.m3u` lists the discs in order so the
emulator can swap them mid-game:

```
psx/
  Final Fantasy VII (USA)/
    Final Fantasy VII (USA) (Disc 1).chd
    Final Fantasy VII (USA) (Disc 2).chd
    Final Fantasy VII (USA) (Disc 3).chd
    Final Fantasy VII (USA).m3u
```

The playlist uses **relative filenames**; absolute paths would break the moment
the library moved.

Multi-file games get a subfolder, single-file games stay flat. Mixing the two is
what makes a library annoying to browse.

## `.cue` rewriting

A `.cue` references its `.bin` files by name. Rename a bin without updating the
cue and it points at a file that no longer exists — nothing errors at extract
time, nothing errors at scan time, and the game simply refuses to boot.

Every rename is therefore paired with a rewrite of the sidecar. The same applies
to `.gdi` (Dreamcast) and `.ccd` sets, in their own syntaxes. Disable with
`REWRITE_CUE_PATHS=false`, though there is rarely a reason to.

With CHD conversion on — the default for disc platforms — this mostly stops
mattering, because a `.chd` is a single file with no sidecar at all.

## Platform folder names

Front-ends auto-detect systems by folder name and they do not agree with each
other. A mismatch is not a data error: the files are fine, but the front-end
shows an empty system and the games look missing.

`PLATFORM_FOLDER_STYLE` selects a preset:

| Our slug | `slug` *(default)* | `esde` | `batocera` |
|---|---|---|---|
| `nes` `snes` `n64` `gb` `gbc` `gba` `nds` `wii` `saturn` `psx` `ps2` `ps3` `psp` | *identical across all three* | | |
| `ngc` | `ngc` | `gc` | `gamecube` |
| `dc` | `dc` | `dreamcast` | `dreamcast` |
| `genesis` | `genesis` | `genesis` ¹ | `megadrive` |
| `xbox` | `xbox` | — ² | `xbox` |
| `xbox360` | `xbox360` | — ² | `xbox360` ³ |

¹ ES-DE ships **both** `genesis` and `megadrive` as separate systems, split by
region. The preset uses `genesis`; override if your set is PAL/JP.
² Not shipped by ES-DE — it needs a custom system definition on the front-end
side regardless of what we name the folder.
³ Not verified against current Batocera docs; confirm before relying on it.

`retroarch` is accepted and maps to `slug`. RetroArch builds playlists by
scanning content and matching against DATs rather than trusting folder names, so
the folder name genuinely does not matter there. The preset exists so the setting
is not a lie, not because it does anything.

### Per-platform overrides

`PLATFORM_FOLDER_MAP` layers on top of any preset, so you never need to fork a
whole map to fix one entry:

```yaml
PLATFORM_FOLDER_STYLE: "esde"
PLATFORM_FOLDER_MAP: "genesis=megadrive,xbox=microsoft-xbox"
```

Precedence: `PLATFORM_FOLDER_MAP` entry → preset → raw slug.

**Validated at boot.** An unknown slug on the left-hand side — a typo like
`gamecube=gc`, when our slug is `ngc` — is logged, surfaced as a warning banner in
Settings, and ignored. It does not crash the container, but it also does not
silently mis-file 400 games without telling you.
