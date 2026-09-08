import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { definePlugin, runArchGuard } from '@velaros-ai/arch-guard'
import {
  codeStyleChecks,
  createCodeStyleDefaults,
  forbidConsole,
  forbidRawTimers,
  requireChineseComments,
} from '@velaros-ai/arch-guard/checks/code-style'

function temporaryProject(files) {
  const rootDir = mkdtempSync(join(tmpdir(), 'arch-guard-code-style-'))
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = join(rootDir, relativePath)
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, contents, 'utf8')
  }
  return rootDir
}

async function runChecks(rootDir, checks, defaults) {
  const plugin = definePlugin({ name: 'code-style-test', checks, defaults })
  const silent = { name: 'silent', report() {} }
  const result = await runArchGuard({
    config: { rootDir, plugins: [plugin], checks: [] },
    reporters: [silent],
    logLevel: 'error',
    ignoreBaseline: true,
    warnStaleBaseline: false,
    fix: false,
  })
  return result.aggregate.allViolations
}

test('exposes the code-style ruleset under its own namespace', () => {
  assert.ok(codeStyleChecks.length >= 30)
  for (const check of codeStyleChecks) {
    assert.ok(check.id.startsWith('code-style/'), `unexpected id: ${check.id}`)
    assert.ok(check.tags?.includes('code-style'))
  }
  assert.equal(forbidConsole.id, 'code-style/forbid-console')
})

test('fans shared scope options out to every rule', () => {
  const defaults = createCodeStyleDefaults({
    scope: { runtimeRoots: ['src/'] },
    perCheck: { 'code-style/forbid-console': { allowFiles: ['src/logger.ts'] } },
  })
  assert.deepEqual(defaults['code-style/forbid-console'], {
    runtimeRoots: ['src/'],
    allowFiles: ['src/logger.ts'],
  })
  assert.deepEqual(defaults['code-style/forbid-raw-timers'], { runtimeRoots: ['src/'] })
})

test('reports a violation and goes quiet once the source is fixed', async () => {
  const violating = temporaryProject({ 'src/service.ts': 'export const run = () => console.log(1)\n' })
  const reported = await runChecks(violating, [forbidConsole])
  assert.equal(reported.length, 1)
  assert.equal(reported[0].checkId, 'code-style/forbid-console')

  const clean = temporaryProject({ 'src/service.ts': 'export const run = () => Log.info(1)\n' })
  assert.deepEqual(await runChecks(clean, [forbidConsole]), [])
})

test('honours scope options: runtimeRoots narrows, allowFiles exempts', async () => {
  const rootDir = temporaryProject({
    'src/service.ts': 'export const run = () => setTimeout(() => undefined, 1)\n',
    'tools/script.ts': 'export const build = () => setTimeout(() => undefined, 2)\n',
  })

  const unscoped = await runChecks(rootDir, [forbidRawTimers])
  assert.equal(unscoped.length, 2, '未声明 runtimeRoots 时不按根过滤')

  const scoped = await runChecks(rootDir, [forbidRawTimers], {
    'code-style/forbid-raw-timers': { runtimeRoots: ['src/'] },
  })
  assert.deepEqual(
    scoped.map((violation) => violation.file),
    ['src/service.ts']
  )

  const exempted = await runChecks(rootDir, [forbidRawTimers], {
    'code-style/forbid-raw-timers': { runtimeRoots: ['src/'], allowFiles: ['src/service.ts'] },
  })
  assert.deepEqual(exempted, [])
})

test('team-language rule exempts public API JSDoc but not implementation comments', async () => {
  const rootDir = temporaryProject({
    'src/api.ts': [
      '/** Public API documentation written for external consumers of this package. */',
      'export function publicApi(): void {',
      '  // This explanatory comment sits inside the implementation body.',
      '}',
      '',
    ].join('\n'),
  })

  const exempted = await runChecks(rootDir, [requireChineseComments])
  assert.equal(exempted.length, 1)
  assert.match(exempted[0].message, /implementation body/)

  const strict = await runChecks(rootDir, [requireChineseComments], {
    'code-style/require-chinese-comments': { exemptExportedJsDoc: false },
  })
  assert.equal(strict.length, 2)
})

test('team-language comments ignore literal text around template substitutions, regexes and JSX', async () => {
  const rootDir = temporaryProject({
    'src/literals.tsx': [
      'const value = "selected";',
      'const url = `Use ${value} from https://example.com/download and refresh the command environment.`;',
      'const shell = `p=$(command -v ${value}); case "$p" in /*) printf "This shell text is not a source comment" ;; esac`;',
      'const nested = `${`inner ${value} https://example.com/this is only literal text`} suffix /* this remains literal template prose */`;',
      'const pattern = /[/*] this regular expression text is not a comment [*/]/;',
      'const view = <p>https://example.com/this is literal rendered text</p>;',
      'const spaced = <p>\n  <b>text</b>\n</p>;',
    ].join('\n'),
  })
  assert.deepEqual(await runChecks(rootDir, [requireChineseComments]), [])
})

test('team-language comments still inspect interpolation code and comments after literal boundaries', async () => {
  const rootDir = temporaryProject({
    'src/comments.ts': [
      'const value = `start ${',
      '  // This explanatory comment belongs to the interpolation expression.',
      '  42',
      '} https://example.com/this remains literal template prose`;',
      '// This explanatory comment follows the completed template expression.',
      'const pattern = /[/*] this is literal regular expression text [*/]/;',
      '/* This explanatory comment follows the completed regular expression. */',
    ].join('\n'),
  })
  const violations = await runChecks(rootDir, [requireChineseComments])
  assert.deepEqual(violations.map((entry) => entry.line), [2, 5, 7])
})

test('team-language literal skipping preserves the optional prose string rule', async () => {
  const rootDir = temporaryProject({
    'src/strings.ts': 'const explanation = "This explanatory string still needs the configured language.";',
  })
  const violations = await runChecks(rootDir, [requireChineseComments], {
    'code-style/require-chinese-comments': { scanStrings: true },
  })
  assert.equal(violations.length, 1)
  assert.match(violations[0].ruleId, /string/u)
})
