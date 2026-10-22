# Changelog

Each release, newest first. The GitHub release for each tag has the same notes.

## 0.1.0-beta.2

- **Refine:** a long prompt no longer vanishes. The prompt and edit boxes grow with the text, from 3 to 12 lines, then scroll. The Other answer, the helper note and the problem report boxes show 2 to 3 lines. Needs a Claude Code version whose text boxes take a height; older versions keep one line (#1).

## 0.1.0-beta.1

The first public beta.

- **Clean View:** a checklist of plain-English steps instead of every tool call, with the plan limit and context gauges, a stuck warning with Stop, and a notice when a long job ends.
- **Crew:** helpers that split big jobs, each on the cheapest model that fits its part, with lanes and a done gate.
- **Refine:** turns a rough prompt into a clear one before it is sent.
- **Guards:** the Secret guard keeps `.env` files and keys out of the chat; the Package guard checks every package before it is installed; the Trimmer cuts long logs.
- **Logbook:** memory between sessions in a folder of Markdown notes.
- **Work Report:** tasks done and the estimated hours and value, with a Timeline of snapshots after each edit.
- **Footer, Shipyard, Window and Safe symbols.**
- **Setup:** six questions the first time Claude Code opens.
- **One look, Deep Sea.** New themes coming soon.
- Installers for macOS, Linux and Windows, with a one-command uninstall.
