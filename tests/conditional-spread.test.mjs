import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { definePlugin, runArchGuard } from '@velaros-ai/arch-guard'
import {
  createCodeStyleDefaults,
  forbidSinglePropertyConditionalSpread,
} from '@velaros-ai/arch-guard/checks/code-style'

/**
 * 单属性条件展开：`...(c ? { k: v } : {})` / `...(c ? {} : { k: v })` / `...(c && { k: v })`。
 *
 * 0.3.0 只在能自动修复（真值 self、类型守卫 self）时才报，`isUndefined(v) ? {} : { k: v }` 这类
 * 取反写法和普通条件整片漏过。这里钉住：所有形态都报，只有值语义不变的才自动修。
 */

function temporaryProject(files) {
  const rootDir = mkdtempSync(join(tmpdir(), 'arch-guard-conditional-spread-'))
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = join(rootDir, relativePath)
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, contents, 'utf8')
  }
  return rootDir
}

async function run(rootDir, { fix = false } = {}) {
  const plugin = definePlugin({
    name: 'conditional-spread-test',
    checks: [forbidSinglePropertyConditionalSpread],
    defaults: createCodeStyleDefaults({ helpers: { module: '@acme/core' } }),
  })
  const result = await runArchGuard({
    config: { rootDir, plugins: [plugin], checks: [] },
    reporters: [{ name: 'silent', report() {} }],
    logLevel: 'error',
    ignoreBaseline: true,
    warnStaleBaseline: false,
    fix,
  })
  return result.aggregate.allViolations
}

function lines(violations) {
  return violations.map((violation) => violation.line).sort((left, right) => left - right)
}

test('reports every single-property conditional spread form', async () => {
  const rootDir = temporaryProject({
    'src/build.ts': [
      'export function build(v: number | undefined, name: string | null, cond: boolean, flag: boolean) {',
      '  return {',
      '    ...(isUndefined(v) ? {} : { v }),',
      '    ...(v === undefined ? {} : { total: v }),',
      '    ...(name != null ? { name } : {}),',
      '    ...(cond ? { a: 1 } : {}),',
      '    ...(cond ? {} : { b: 2 }),',
      '    ...(cond && { c: 3 }),',
      '    ...(cond ? { d: 4 } : undefined),',
      '    ...(cond ? { e: 5 } : null),',
      '    ...(flag ? { flag } : {}),',
      '    ...((cond ? { f: 6 } : {}) as { f?: number }),',
      '  }',
      '}',
      '',
    ].join('\n'),
  })
  const violations = await run(rootDir)
  assert.deepEqual(lines(violations), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  for (const violation of violations) {
    assert.equal(violation.checkId, 'code-style/forbid-single-property-conditional-spread')
  }
  const byLine = new Map(violations.map((violation) => [violation.line, violation.message]))
  assert.match(byLine.get(6), /`a: optionalWhen\(cond, 1\)`/)
  assert.match(byLine.get(7), /`b: optionalWhen\(!cond, 2\)`/)
  assert.match(byLine.get(11), /''\/0\/false/)
})

test('leaves grouped and plain spreads alone', async () => {
  const rootDir = temporaryProject({
    'src/build.ts': [
      'export function build(base: object, cond: boolean) {',
      '  return {',
      '    ...base,',
      '    ...(cond ? base : {}),',
      '    ...(cond ? { a: 1, b: 2 } : {}),',
      '    ...(cond ? { a: 1 } : { a: 2 }),',
      '    ...(cond ? { ...base } : {}),',
      '  }',
      '}',
      '',
    ].join('\n'),
  })
  assert.deepEqual(await run(rootDir), [])
})

test('reports JSX spread attributes', async () => {
  const rootDir = temporaryProject({
    'src/view.tsx': [
      'export const View = (props: { title?: string; label: string; cond: boolean }) => (',
      '  <div',
      '    {...(isUndefined(props.title) ? {} : { title: props.title })}',
      "    {...(props.cond ? { 'aria-label': props.label } : {})}",
      '  />',
      ')',
      '',
    ].join('\n'),
  })
  assert.deepEqual(lines(await run(rootDir)), [3, 4])
})

test('fixes only the forms whose value stays the same', async () => {
  const rootDir = temporaryProject({
    'src/build.ts': [
      'export function build(v: number | undefined, name: string | null, label: unknown, cond: boolean, flag: boolean) {',
      '  return {',
      '    ...(isUndefined(v) ? {} : { v }),',
      '    ...(v !== undefined ? { total: v } : {}),',
      '    ...(name != null ? { name } : {}),',
      '    ...(isString(label) ? { label } : {}),',
      '    ...(cond ? { a: 1 } : {}),',
      '    ...(flag ? { flag } : {}),',
      '  }',
      '}',
      '',
    ].join('\n'),
  })
  await run(rootDir, { fix: true })
  const fixed = readFileSync(join(rootDir, 'src/build.ts'), 'utf8')
  assert.match(fixed, /^ {4}v,$/mu)
  assert.match(fixed, /^ {4}total: v,$/mu)
  assert.match(fixed, /^ {4}name: toOptional\(name\),$/mu)
  assert.match(fixed, /^ {4}label: optionalWhen\(isString, label\),$/mu)
  assert.match(fixed, /\.\.\.\(cond \? \{ a: 1 \} : \{\}\)/u, '普通条件只报不修')
  assert.match(fixed, /\.\.\.\(flag \? \{ flag \} : \{\}\)/u, "真值 self 会把 ''/0/false 变成写入，只报不修")
  const imports = fixed.split('\n').filter((line) => line.includes("from '@acme/core'")).join('\n')
  assert.match(imports, /\btoOptional\b/u)
  assert.match(imports, /\boptionalWhen\b/u)
  assert.equal((await run(rootDir)).length, 2)
})

test('does not fix after an earlier spread, with casts, comments or computed keys', async () => {
  const source = [
    'export function withBase(base: { v?: number }, v: number | undefined) {',
    '  return {',
    '    ...base,',
    '    ...(isUndefined(v) ? {} : { v }),',
    '  }',
    '}',
    'export function withCast(v: number | undefined) {',
    '  return { ...((isUndefined(v) ? {} : { cast: v }) as object) }',
    '}',
    'export function withComment(v: number | undefined) {',
    '  return { ...(isUndefined(v) ? {} /* 保留 */ : { commented: v }) }',
    '}',
    'export function withComputed(v: number | undefined, key: string) {',
    '  return { ...(isUndefined(v) ? {} : { [key]: v }) }',
    '}',
    '',
  ].join('\n')
  const rootDir = temporaryProject({ 'src/build.ts': source })
  const violations = await run(rootDir, { fix: true })
  assert.equal(readFileSync(join(rootDir, 'src/build.ts'), 'utf8'), source)
  assert.deepEqual(lines(violations), [4, 8, 11, 14])
  const byLine = new Map(violations.map((violation) => [violation.line, violation.message]))
  assert.match(byLine.get(4), /盖掉展开出来的同名字段/u)
  assert.match(byLine.get(14), /动态键/u)
})

test('fixes JSX spread attributes into plain attributes', async () => {
  const rootDir = temporaryProject({
    'src/view.tsx': [
      'export const View = (props: { title?: string }) => (',
      '  <div {...(isUndefined(props.title) ? {} : { title: props.title })} />',
      ')',
      '',
    ].join('\n'),
  })
  await run(rootDir, { fix: true })
  assert.match(readFileSync(join(rootDir, 'src/view.tsx'), 'utf8'), /<div title=\{props\.title\} \/>/u)
})
