# Contributing to carapace

Thank you for helping. carapace is in beta, so bug reports and small, focused fixes help the most.

## Report a problem

- In Claude Code, press **⚑ Problem** on the bar (it shows after an error) or run `/mods problem`. It fills in your versions and the error lines, and shows everything before it is sent.
- Or open an issue with the **Bug report** form.
- Security problems: do not open an issue. See [SECURITY.md](SECURITY.md).

## Set up

```sh
git clone https://github.com/dheerajponnaganti/carapace.git ~/carapace
~/carapace/install.sh
cd ~/carapace && git checkout dev
git config core.hooksPath .githooks
```

The installer lists your clone in `CLAUDE_CODE_PLUGIN_DIRS`, so every interactive Claude Code session loads it and reloads every mod when you save a file. A new mod is one import and one call in `hooks/register.tsx`. No restart.

The hook in `.githooks` stops direct pushes to `main` and `dev`.

## Checks

Run these before you open a pull request. CI runs them too, on the oldest and newest Claude Code carapace supports.

```sh
claude plugin validate .
claude plugin test .
npx -y -p typescript@5.6.3 tsc -p . --noEmit
scripts/test-install.sh
scripts/test-install-ps1.sh   # needs PowerShell (pwsh); skips without it
```

Every mod has at least one test. A change in behaviour comes with a test that shows it.

## Branches and pull requests

- `main` is stable: it is what everyone's `/mods update` pulls.
- `dev` is where changes land first.
- Make a short-lived branch from `dev`: `fix/<name>` for a bug, `feature/<name>` for new behaviour, `mod/<name>` for a new mod, `docs/<name>` for docs, `chore/<name>` for installers, CI and tooling.
- Open the pull request into `dev`: `gh pr create --base dev`. It is squashed into one commit, so the title and description should say what changed and why.
- The maintainer moves `dev` to `main` in a release and tags it.

For a new mod or a large change, open an issue first so we can agree on the shape before you build it.

## How a mod is written

Each mod is a module in `mods/<name>/`, loaded by `hooks/register.tsx`. The engine's types are in `.claude-plugin/types/` once Claude Code has loaded the plugin; grep them for any event or `$` call.

- Export `register<Name>(on: On)` from `mods/<name>/<name>.tsx`.
- One plugin hooks each event once per matcher, and `$` never crosses an import: functions that take `$` live at the top level of the file that uses them. When a new mod needs an event another mod already hooks without a matcher, give the new hook a matcher that states its real scope (`{ isInteractive: true }`, `{ tool: ['Bash', 'Edit'] }`, `{ id: 'my-pane' }`).
- Every command answers with `{ text }`, even when it only opens a pane. Claude Code treats a reply with no text as "no command.run hook answered".
- Hook calls stay literal (`on('event', ...)`, `$.noun.method(...)`): `claude plugin validate` reads them from the source.
- State lives under the `carapace` key in `types/index.d.ts`. Prefix new keys with the mod's name.
- Tools a mod registers are named `mcp__carapace__<name>`.
- Colors come from the shared palette (`PALETTES.deep` in `mods/shared/look.ts`) and names from `WORDS`. Never hard-code a color in a mod.
- Build panes from `mods/shared/ui.tsx` (paneTitle, heading, chip, tile, meter, barRow, card, emptyState) and glyphs from `GLYPH`.
- Pane titles use spaced capitals; everything else uses plain small capitals.
- Motion: only live things move, once a second. The exceptions: the Crew's sonar sweep (4 a second while helpers run), the two-second surfacing, and the one-second ping ring when a turn ends.
- Glow is the halo: `pal.halo` and `pal.halo2` one and two cells out from what is lit, `breathe()` on live marks, and `hover` on chips. A `hover` needs a keyed Box around its Button.
- `turn.step` streams: its hook is an `async function*` that ends with `return yield* next(e)`.
- A new mod gets one named button in the bar, a slash command with the same name, and a row in the Shipyard with a matching letter. Guards that work on their own (Secret guard, Trimmer, Package guard) get a slash command for status and on/off, and no button. The bar's buttons and the Shipyard's rows live in `mods/deck/deck.tsx`.
- Buttons never run a slash command: Claude Code skips a plugin's own hooks for an event the plugin raises itself. The launcher opens the mod's pane itself, writing the same state the mod's command writes.
- `$.ui.open` must be the first `$` call a press or a command makes. Then the pane counts as asked for and opens at any width; after another `$` call it needs 144 columns.
- Clean View's bar hook is registered before the deck's, so the deck's AbovePrompt hook sits inside it and answers with the buttons alone. An engine node may not sit inside a Box with a `width`.
- The bar and every pane paint `pal.surface` as their background.
- Never depend on `Image` or `Raster`: default terminals cannot draw them.

A new mod also needs a row in the README.

## Writing

Text people read (the README, messages, command descriptions, comments) uses short, plain sentences. No em or en dashes, no filler words ("just", "simply", "actually"), and no "not X but Y" constructions.

## License

By contributing, you agree that your work is released under the [MIT License](LICENSE).
