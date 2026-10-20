// The one list of commands that count as a check (test, build, type check, lint), for the trimmer, the time machine
// and Logbook alike. Each step of a shell line is matched from its start, so `echo npm test` and `cat test.log` are not checks.

const RUN = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|check|typecheck)[\w:-]*(?:\s|$)/,
  /^npx\s+(?:\S+\s+)*?(?:jest|vitest|playwright|tsc|eslint)(?:\s|$)/,
  /^(?:tsc|jest|vitest|eslint|ruff|mypy|pytest)(?:\s|$)/,
  /^python3?\s+-m\s+(?:pytest|unittest|mypy)(?:\s|$)/,
  /^go\s+(?:test|build|vet)(?:\s|$)/,
  /^cargo\s+(?:test|build|check|clippy)(?:\s|$)/,
  /^swift\s+(?:test|build)(?:\s|$)/,
  /^xcodebuild(?:\s|$)/,
  /^(?:\.\/)?gradlew?\s+(?:\S+\s+)*?(?:test|build|check)(?:\s|$)/,
  /^mvn\s+(?:\S+\s+)*?(?:test|verify|package)(?:\s|$)/,
  /^make(?:\s+(?:test|check|build)(?:\s|$)|$)/,
  /^(?:bundle\s+exec\s+)?rspec(?:\s|$)/,
  /^(?:\.\/vendor\/bin\/)?phpunit(?:\s|$)/,
  /^dotnet\s+(?:test|build)(?:\s|$)/,
  /^claude\s+plugin\s+(?:test|validate)(?:\s|$)/,
  /^(?:bash|sh)\s+\S*test\S*(?:\s|$)/,
]

/** True when some step of the shell line is a known test, build, type check or lint run. */
export function isCheckCommand(command: string): boolean {
  return command.split(/&&|\|\||[;|\n]/).some(step => {
    const s = step.trim().replace(/^\(+/, '').replace(/^(?:\w+=\S*\s+)+/, '')

    return RUN.some(r => r.test(s))
  })
}
