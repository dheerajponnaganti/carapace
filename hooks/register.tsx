import type { Register } from 'claude-code'

import { registerAgentDock } from '../mods/agent-dock/dock'
import { registerCleanView } from '../mods/clean-view/clean-view'
import { registerDeck } from '../mods/deck/deck'
import { registerGlyphs } from '../mods/glyphs/glyphs'
import { registerFooter } from '../mods/footer/footer'
import { registerLogbook } from '../mods/logbook/logbook'
import { registerPackageGuard } from '../mods/package-guard/package-guard'
import { registerPromptUpgrade } from '../mods/prompt-upgrade/prompt-upgrade'
import { registerSecretGuard } from '../mods/secret-guard/secret-guard'
import { registerTrimmer } from '../mods/trimmer/trimmer'
import { registerWorkReport } from '../mods/work-report/work-report'
import { registerWindow } from '../mods/window/window'

// One line per mod. Saving this file hot reloads every mod, new ones included.
// Agent Dock first: its hooks on helpers' report_progress must run before Clean View's.
// Work Report last, so it only counts prompts the other mods let through.
// The deck owns the theme; every pane reads the skin it picks.
export const register: Register = on => {
  // First: its render hook wraps every drawing to swap symbols some consoles draw two cells wide.
  registerGlyphs(on)
  registerAgentDock(on)
  // Clean View draws the bar; the deck, nested inside it, draws the bar's buttons.
  registerCleanView(on)
  registerDeck(on)
  registerPromptUpgrade(on)
  registerWorkReport(on)
  registerFooter(on)
  registerSecretGuard(on)
  registerTrimmer(on)
  registerPackageGuard(on)
  registerLogbook(on)
  // Last: it reads the context the other mods keep, and paints the Terminal tab.
  registerWindow(on)
}
