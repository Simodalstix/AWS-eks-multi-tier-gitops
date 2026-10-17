# Study page: markdown conventions

`scripts/build-study.sh` renders the sources below into one file,
`docs/study/index.html`. Edit the markdown, rebuild, reload the page.

## Sources

| Path | Page section | One reviewable item per |
|---|---|---|
| `docs/troubleshooting-spine.html` | Spine | the whole page, embedded unchanged |
| `docs/adr/*.md` | Trade-offs | file (card) |
| `runbooks/*.md` | Drills | file (card) |
| `docs/notes/linux-map.md` | Linux map | `##` section |
| `docs/notes/*.md`, all others | Concepts | `##` section |

- Skipped: files whose name starts with `_` (templates) and `README.md`.
- Order: by file name. Name ADRs `NNNN-short-slug.md`, runbooks `short-slug.md`.
- Reviewed marks are keyed by file name and `##` heading. Renaming either
  clears that mark.

## Every file

- The first `# ` line is the title.
- Between the title and the first `##`, lines shaped `Key: value` become
  chips on the card (`Status: Accepted`, `Date: 2026-10-18`). Any other text
  there becomes an intro paragraph. Put chips before intro text.
- `##` headings split the file into sections. Headings are matched
  case-insensitively, ignoring punctuation.

## ADRs (`docs/adr/`)

Four required sections. Each renders as one box on the card.

| `##` heading | Box | Content |
|---|---|---|
| Context | Context | forces, constraints, numbers |
| Options | Options | a table, one row per option |
| Decision | Decision | hidden while Cover is on |
| When I would flip it | When I would flip it | measurable conditions |

Any other `##` section renders full width under the four boxes. A missing
required section renders a placeholder and the build prints a warning.

## Runbooks (`runbooks/`)

Six required sections: Detect, Triage, Mitigate, Diagnose, Fix, Postmortem.

- Detect to Fix render left to right as the step strip. Fix is hidden while
  Cover is on.
- Postmortem renders in the side panel. Write exactly 10 list items shaped
  `- Label: text`. The build warns on any other count.

## Notes (`docs/notes/`)

- Each `##` section is one block with its own Reviewed checkbox and nav entry.
- Fragments and tables, not prose. A block should fit on one screen.

## Markdown the renderer supports

- `#` to `######` headings, paragraphs, `---` rule, `>` quotes.
- Lists with `-`, `*` or `1.`. Nest by indenting two spaces.
- Tables with a `|---|` separator row. Write a literal pipe in a cell as `\|`,
  including inside inline code.
- Fenced code blocks with three backticks. Each gets a Copy button.
- Inline code, `**bold**`, `*italic*`, `[text](url)`.

Not supported: raw HTML (shown as text), images, footnotes, reference-style
links, setext (underlined) headings.

## Build

```
scripts/build-study.sh                       # writes docs/study/index.html
scripts/build-study.sh --out /tmp/x.html     # write somewhere else
scripts/build-study.sh --include-templates   # also render _template.md files
```

Node 18 or later, standard library only. The output has no external requests
and works from `file://`.
