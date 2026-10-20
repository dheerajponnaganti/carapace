# Security

## Report a vulnerability

Please report security problems privately. Do not open a public issue.

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Say what you found, how to reproduce it, and what it could let someone do.

You will get a reply within a week. Once a fix is released, the report can be made public, with credit to you if you want it.

## What counts

carapace runs inside Claude Code with your permissions, so these matter most:

- A way past the Secret guard: a `.env` file, key or token reaching the chat.
- A way past the Package guard: a package installed without the check.
- carapace sending anything off your computer beyond what the README's "What stays on your computer" lists.
- The installer or `/mods update` running code that did not come from this repository or an add-on's own source.

## Supported versions

Only the latest release gets fixes during the beta.
