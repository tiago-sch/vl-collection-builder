# Screenshots

Drop images here. They are tracked by git and excluded from the Docker build
context, so they add nothing to the image.

## Naming

Use the screen name, lower-case, hyphenated:

| File | Shows | In use |
|---|---|---|
| `logo.png` | Wordmark, transparent background, 900px | README header |
| `review_step.png` | The review queue with a genuine 0.79 / 0.79 tie | README |
| `import_list.png` | The Import screen with a pasted list | README |
| `downloads.png` | The download queue and a completed transfer | README |
| `library.png` | The saved library with tier badges | not yet |
| `settings.png` | Settings | not yet |
| `wizard-regions.png` | The first-run region step | not yet |

`vl_collection_builder.png` is the full-size source art for the logo. `logo.png`
is the cropped, resized version the README uses — the source is 2.1 MB against
326 KB, which matters because git keeps every version of a binary forever.

## Capturing

The UI is dark-themed, so screenshots look best on a dark page and are readable
on GitHub in either theme.

- **Width 1280** matches the app's max content width without wasted margin.
- **PNG**, not JPEG — text and flat panels compress badly as JPEG and look
  smeared.
- Trim browser chrome. The content is the point.
- Keep each file under ~300 KB. Git stores every version of a binary forever, so
  a habit of committing 4 MB retina captures makes the repository unpleasant to
  clone quite quickly.

On macOS, `⌘⇧4` then `Space` captures a single window; hold `Option` while
clicking to drop the drop-shadow.

## Referencing them

Relative paths from the README, which GitHub resolves correctly:

```markdown
![The review queue](docs/images/review.png)
```

From a file inside `docs/`, go up one level:

```markdown
![The review queue](images/review.png)
```

The README currently shows the review queue as a text mock-up. Replacing it with
a real screenshot is a straight swap — the block sits directly under the intro
paragraph.
