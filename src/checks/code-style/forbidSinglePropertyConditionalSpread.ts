import { defineCheck } from '../../core/defineCheck'
import type { FixContext } from '../../core/fixContext'
import ts from 'typescript'

import { fixReplaceSpan, type HelperImportSources, readHelperImportSources } from './_fix'
import { collectCodeStyleFiles, getCachedSourceFile, lineOf, snippetOf, walk } from './_shared'
import { CodeStyleFixPhase } from './fixPhases'

/**
 * 禁止单属性条件对象展开。
 *
 * `...(cond ? { field: value } : {})`、`...(cond ? {} : { field: value })`、`...(cond && { field: value })`
 * 为了「条件不成立就不写这个键」绕一个条件对象再展开，读的人得先在脑子里把条件求一遍值。
 * 单个可选字段直接写成字段：
 * - `isUndefined(v) ? {} : { k: v }` / `v === undefined ? {} : { k: v }` → `k: v`
 * - `isPresent(v) ? { k: v } : {}` / `v != null ? { k: v } : {}` → `k: toOptional(v)`
 * - 类型守卫 self（`isString(v) ? { k: v } : {}`）→ `k: optionalWhen(isString, v)`
 * - 真值 self（`v ? { k: v } : {}`）→ `k: toOptional(v)`；v 可能是 ''/0/false 且原意要丢掉这些值时保留判断
 * - 其余条件 → `k: optionalWhen(cond, value)`；取值依赖条件成立（可选成员、函数调用）时用 `optionalWhenLazy`
 *
 * JSX 的展开属性同理：`<X {...(cond ? { title } : {})} />` → `<X title={optionalWhen(cond, title)} />`。
 *
 * 「键缺席」与「键为 undefined」不等价的地方（请求头、URLSearchParams、环境变量、按键枚举的参数、
 * 之后会被展开到默认值之上的选项）不要换成字段，改成先构造对象、再用 if 赋值。
 * 两个及以上字段整组出现/缺席时仍可使用条件展开。
 *
 * 自动修复只做值语义完全不变的几类（undefined 判断、null 判断、类型守卫 self），并且在下列情况只报不修：
 * 同一对象里前面已有展开（直接写字段会用 undefined 盖掉展开出来的同名字段）、计算属性名、
 * 展开参数带类型断言、表达式里有注释。真值 self 会把 ''/0/false 从缺席变成写入，同样只报不修。
 */
const forbidSinglePropertyConditionalSpread = defineCheck({
  id: 'code-style/forbid-single-property-conditional-spread',
  title: 'Forbid single-property conditional object spread',
  description:
    '单个可选字段不要写成条件对象展开（`...(c ? { k: v } : {})` / `...(c ? {} : { k: v })` / `...(c && { k: v })`）；直接写 `k: v` / `k: toOptional(v)` / `k: optionalWhen(c, v)`。',
  verifies: [
    '识别对象字面量与 JSX 展开属性中的单属性条件展开：三元两种分支顺序、`&&` 形式，空分支可为 `{}` / `undefined` / `null`。',
    '只有一个分支是单属性对象、另一个分支为空时才报；两个及以上字段整组出现/缺席的条件展开不报。',
    '自动修复只做值语义不变的 undefined 判断、null 判断与类型守卫 self；前面已有展开、计算属性名、带类型断言或注释时只报不修。',
  ],
  tags: ['code-style', 'object-assembly'],
  defaultSeverity: 'error',
  run({ context, report }) {
    const section = report.section('Single-property conditional object spread')
    const helpers = readHelperImportSources(context)
    for (const info of collectCodeStyleFiles(context)) {
      const sourceFile = getCachedSourceFile(context, info)
      walk(sourceFile, (node) => {
        const match = readSinglePropertyConditionalSpread(node, sourceFile)
        if (!match) return

        const line = lineOf(sourceFile, node)
        section.add({
          ruleId: 'prefer-to-optional-field',
          file: info.relativePath,
          line,
          message: `${info.relativePath}:${line}: "${snippetOf(sourceFile, node)}" 是单属性条件对象展开。${match.advice}`,
          fingerprintInput: `${info.relativePath}::${line}::single-property-conditional-spread::${match.propertyName}`,
          ...(match.fixText
            ? {
                fixPhase: CodeStyleFixPhase.preferToOptionalOverConditionalSpread,
                fixStartOffset: node.getStart(sourceFile),
                applyFix: fixReplaceText(info.relativePath, sourceFile, node, match.fixText, helpers),
              }
            : {}),
        })
      })
    }
  },
})

/** 这条规则关心的两种展开：对象字面量里的 `...expr` 与 JSX 的 `{...expr}`。 */
type ConditionalSpreadSite =
  | { kind: 'object'; node: ts.SpreadAssignment; siblings: readonly ts.ObjectLiteralElementLike[] }
  | { kind: 'jsx'; node: ts.JsxSpreadAttribute; siblings: readonly ts.JsxAttributeLike[] }

interface SinglePropertyConditionalSpread {
  propertyName: string
  /** 给人看的改法；不能自动修时也要说清楚怎么写。 */
  advice: string
  /** 值语义不变、可以直接落盘的替换文本；不能安全自动修时为空。 */
  fixText?: string
}

/** 单属性分支里取出的字段。 */
interface SingleProperty {
  /** 属性名源文本（标识符 / 字符串字面量 / 数字字面量 / 计算属性名）。 */
  nameText: string
  valueText: string
  /** 去掉外层括号后的取值文本，只用于和条件里的被测表达式比较。 */
  comparableValueText: string
  computed: boolean
  /** 对象里写 `{ k }` 的简写形式。 */
  shorthand: boolean
}

/** 条件与单属性分支的对应关系：`present` = 条件成立时写入字段。 */
interface ConditionalShape {
  condition: ts.Expression
  property: SingleProperty
  presentWhenConditionTrue: boolean
}

function readSinglePropertyConditionalSpread(
  node: ts.Node,
  sourceFile: ts.SourceFile
): SinglePropertyConditionalSpread | undefined {
  const site = readSpreadSite(node)
  if (!site) return undefined
  const unwrapped = unwrapExpression(site.node.expression)
  const shape = readConditionalShape(unwrapped.expression, sourceFile)
  if (!shape) return undefined

  const { property } = shape
  const replacement = describeReplacement(shape, sourceFile)
  const blockers = readFixBlockers(site, sourceFile, property, unwrapped.hadTypeWrapper)
  const target = formatTarget(site.kind, property, replacement.valueText)
  const fixable = replacement.exact && blockers.length === 0
  return {
    propertyName: property.nameText,
    advice: buildAdvice(site, property, replacement, target, blockers),
    fixText: fixable ? target : undefined,
  }
}

function readSpreadSite(node: ts.Node): ConditionalSpreadSite | undefined {
  if (ts.isSpreadAssignment(node) && ts.isObjectLiteralExpression(node.parent)) return { kind: 'object', node, siblings: node.parent.properties }
  if (ts.isJsxSpreadAttribute(node) && ts.isJsxAttributes(node.parent)) return { kind: 'jsx', node, siblings: node.parent.properties }
  return undefined
}

/** 去掉括号、`as` / `satisfies` / `<T>` 断言与非空断言；带断言时自动修复会丢类型，需要标记。 */
function unwrapExpression(expression: ts.Expression): { expression: ts.Expression; hadTypeWrapper: boolean } {
  let current = expression
  let hadTypeWrapper = false
  for (;;) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression
      continue
    }
    if (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      hadTypeWrapper = true
      current = current.expression
      continue
    }
    return { expression: current, hadTypeWrapper }
  }
}

function readConditionalShape(
  expression: ts.Expression,
  sourceFile: ts.SourceFile
): ConditionalShape | undefined {
  if (ts.isConditionalExpression(expression)) {
    const whenTrue = readBranch(expression.whenTrue, sourceFile)
    const whenFalse = readBranch(expression.whenFalse, sourceFile)
    if (whenTrue?.kind === 'single' && whenFalse?.kind === 'empty') return { condition: expression.condition, property: whenTrue.property, presentWhenConditionTrue: true }
    if (whenFalse?.kind === 'single' && whenTrue?.kind === 'empty') return { condition: expression.condition, property: whenFalse.property, presentWhenConditionTrue: false }
    return undefined
  }
  // `...(cond && { k: v })`：cond 为假值时展开的是 false / 0 / '' / null / undefined，效果同 `{}`。
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    const right = readBranch(expression.right, sourceFile)
    if (right?.kind === 'single') return { condition: expression.left, property: right.property, presentWhenConditionTrue: true }
  }
  return undefined
}

function readBranch(
  expression: ts.Expression,
  sourceFile: ts.SourceFile
): { kind: 'empty' } | { kind: 'single'; property: SingleProperty } | undefined {
  const branch = unwrapExpression(expression).expression
  if (isEmptyBranch(branch)) return { kind: 'empty' }
  if (!ts.isObjectLiteralExpression(branch) || branch.properties.length !== 1) return undefined

  const element = branch.properties[0]
  if (!element) return undefined
  if (ts.isShorthandPropertyAssignment(element)) {
    // `{ k = 1 }` 只在解构里合法；这里不认。
    if (element.objectAssignmentInitializer) return undefined
    const name = element.name.getText(sourceFile)
    return {
      kind: 'single',
      property: { nameText: name, valueText: name, comparableValueText: name, computed: false, shorthand: true },
    }
  }
  if (ts.isPropertyAssignment(element)) return {
      kind: 'single',
      property: {
        nameText: element.name.getText(sourceFile),
        valueText: element.initializer.getText(sourceFile),
        comparableValueText: stripParens(element.initializer).getText(sourceFile),
        computed: ts.isComputedPropertyName(element.name),
        shorthand: false,
      },
    }
  return undefined
}

/** `{}`、`undefined`、`void 0`、`null` 展开后都不产生任何键。 */
function isEmptyBranch(expression: ts.Expression): boolean {
  if (ts.isObjectLiteralExpression(expression)) return expression.properties.length === 0
  if (ts.isIdentifier(expression)) return expression.text === 'undefined'
  if (expression.kind === ts.SyntaxKind.NullKeyword) return true
  return ts.isVoidExpression(expression)
}

/**
 * 条件与取值的关系决定改法。
 *
 * `exact` 表示改成 `valueText` 之后字段取值与原来一模一样（只剩「缺席 vs undefined」这层差别）。
 */
interface Replacement {
  valueText: string
  exact: boolean
  /** 真值 self：原写法会把 ''/0/false 当缺席。 */
  truthinessSelf: boolean
}

function describeReplacement(shape: ConditionalShape, sourceFile: ts.SourceFile): Replacement {
  const { condition, property, presentWhenConditionTrue } = shape
  const value = property.valueText
  const comparable = property.comparableValueText
  const test = readNullishTest(condition, sourceFile)
  if (test && sameExpressionText(test.subject, comparable)) {
    const presentWhenTestTrue = test.presentWhenTrue === presentWhenConditionTrue
    if (presentWhenTestTrue) return {
        valueText: test.family === 'undefined' ? value : `toOptional(${value})`,
        exact: true,
        truthinessSelf: false,
      }
  }

  if (presentWhenConditionTrue) {
    const guard = readTypeGuardSelf(condition, sourceFile)
    if (guard && sameExpressionText(guard.subject, comparable)) return { valueText: `optionalWhen(${guard.guardName}, ${value})`, exact: true, truthinessSelf: false }
    if (sameExpressionText(stripParens(condition).getText(sourceFile), comparable)) return { valueText: `toOptional(${value})`, exact: false, truthinessSelf: true }
  }

  const conditionText = presentWhenConditionTrue ? condition.getText(sourceFile) : negate(condition, sourceFile)
  return { valueText: `optionalWhen(${conditionText}, ${value})`, exact: false, truthinessSelf: false }
}

/**
 * 识别「值是否缺席」这一类判断。
 *
 * - `undefined` 家族：`isUndefined(v)`、`isNotUndefined(v)`、`v === undefined`、`typeof v === 'undefined'`（及取反）
 * - `null` 家族：`isPresent(v)`、`isNull(v)`、`isNotNull(v)`、`v == null`、`v != null`、`v === null`（及取反）
 *
 * `presentWhenTrue` = 该判断为真时值「在场」。`null` 家族的在场值统一用 `toOptional(v)` 表达：
 * 原写法在 null 时不写键，toOptional 把 null 归一成 undefined，取值完全一致。
 */
function readNullishTest(
  condition: ts.Expression,
  sourceFile: ts.SourceFile
): { subject: string; family: 'undefined' | 'null'; presentWhenTrue: boolean } | undefined {
  const expression = stripParens(condition)
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = readNullishTest(expression.operand, sourceFile)
    return inner ? { ...inner, presentWhenTrue: !inner.presentWhenTrue } : undefined
  }
  if (ts.isCallExpression(expression) && expression.arguments.length === 1) {
    const callee = stripParens(expression.expression)
    const argument = expression.arguments[0]
    if (!ts.isIdentifier(callee) || !argument) return undefined
    const subject = stripParens(argument).getText(sourceFile)
    switch (callee.text) {
      case 'isUndefined':
        return { subject, family: 'undefined', presentWhenTrue: false }
      case 'isNotUndefined':
        return { subject, family: 'undefined', presentWhenTrue: true }
      case 'isPresent':
      case 'isNotNull':
        return { subject, family: 'null', presentWhenTrue: true }
      case 'isNull':
        return { subject, family: 'null', presentWhenTrue: false }
      default:
        return undefined
    }
  }
  if (ts.isBinaryExpression(expression)) return readNullishComparison(expression, sourceFile)
  return undefined
}

function readNullishComparison(
  expression: ts.BinaryExpression,
  sourceFile: ts.SourceFile
): { subject: string; family: 'undefined' | 'null'; presentWhenTrue: boolean } | undefined {
  const operator = expression.operatorToken.kind
  const negated =
    operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    operator === ts.SyntaxKind.ExclamationEqualsToken
  const loose =
    operator === ts.SyntaxKind.EqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken
  if (
    !negated &&
    !loose &&
    operator !== ts.SyntaxKind.EqualsEqualsEqualsToken
  ) return undefined

  for (const [candidate, other] of [
    [expression.left, expression.right],
    [expression.right, expression.left],
  ] as const) {
    const literal = readNullishLiteral(stripParens(other))
    if (!literal) continue
    const subjectNode = stripParens(candidate)
    const typeofSubject = readTypeofUndefinedSubject(subjectNode, literal)
    if (typeofSubject) return { subject: typeofSubject.getText(sourceFile), family: 'undefined', presentWhenTrue: negated }
    if (literal === 'typeof-undefined') continue
    // `v == null` / `v != null` 同时覆盖 undefined 与 null。
    const family = loose || literal === 'null' ? 'null' : 'undefined'
    return { subject: subjectNode.getText(sourceFile), family, presentWhenTrue: negated }
  }
  return undefined
}

function readNullishLiteral(expression: ts.Expression): 'undefined' | 'null' | 'typeof-undefined' | undefined {
  if (ts.isIdentifier(expression) && expression.text === 'undefined') return 'undefined'
  if (ts.isVoidExpression(expression)) return 'undefined'
  if (expression.kind === ts.SyntaxKind.NullKeyword) return 'null'
  if (ts.isStringLiteral(expression) && expression.text === 'undefined') return 'typeof-undefined'
  return undefined
}

/** `typeof v === 'undefined'` 里的 `v`。 */
function readTypeofUndefinedSubject(
  expression: ts.Expression,
  literal: ReturnType<typeof readNullishLiteral>
): ts.Expression | undefined {
  if (literal !== 'typeof-undefined' || !ts.isTypeOfExpression(expression)) return undefined
  return stripParens(expression.expression)
}

/** 与 optionalWhen 的守卫闭集一致：只认这些 core TypeGuards 谓词。 */
const TypeGuardSelfNames = new Set([
  'isBoolean',
  'isTrue',
  'isFalse',
  'isString',
  'isNonBlankString',
  'isNumber',
  'isPositiveNumber',
  'isFiniteNumber',
  'isFunction',
  'isBigInt',
  'isSymbol',
  'isObject',
  'isRecord',
  'isPlainObject',
  'isArray',
  'isNonEmptyArray',
])

function readTypeGuardSelf(
  condition: ts.Expression,
  sourceFile: ts.SourceFile
): { guardName: string; subject: string } | undefined {
  const call = stripParens(condition)
  if (!ts.isCallExpression(call) || call.arguments.length !== 1) return undefined
  const callee = stripParens(call.expression)
  const argument = call.arguments[0]
  if (!ts.isIdentifier(callee) || !TypeGuardSelfNames.has(callee.text) || !argument) return undefined
  return { guardName: callee.text, subject: stripParens(argument).getText(sourceFile) }
}

/** 取反条件的源文本：`!x` → `x`，其余包一层 `!(...)`（简单标识符/调用/成员访问不加括号）。 */
function negate(condition: ts.Expression, sourceFile: ts.SourceFile): string {
  const expression = stripParens(condition)
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) return stripParens(expression.operand).getText(sourceFile)
  const text = expression.getText(sourceFile)
  const simple =
    ts.isIdentifier(expression) ||
    ts.isCallExpression(expression) ||
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  return simple ? `!${text}` : `!(${text})`
}

function stripParens(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current)) current = current.expression
  return current
}

function sameExpressionText(left: string, right: string): boolean {
  return normalizeExpressionText(left) === normalizeExpressionText(right)
}

function normalizeExpressionText(text: string): string {
  return text.replaceAll(/\s+/g, '')
}

/** 自动修复会改变语义或丢信息的情形；为空时才允许落盘。 */
function readFixBlockers(
  site: ConditionalSpreadSite,
  sourceFile: ts.SourceFile,
  property: SingleProperty,
  hadTypeWrapper: boolean
): string[] {
  const blockers: string[] = []
  const siblings: readonly ts.Node[] = site.siblings
  const earlierSpread = siblings
    .slice(0, Math.max(0, siblings.indexOf(site.node)))
    .some((sibling) => ts.isSpreadAssignment(sibling) || ts.isJsxSpreadAttribute(sibling))
  if (earlierSpread) blockers.push('earlier-spread')
  if (property.computed) blockers.push('computed')
  if (hadTypeWrapper) blockers.push('type-wrapper')
  if (hasComment(site.node, sourceFile)) blockers.push('comment')
  if (hasSiblingNamed(site, sourceFile, property.nameText)) blockers.push('duplicate-name')
  if (site.kind === 'jsx' && !jsxAttributeName(property.nameText)) blockers.push('jsx-name')
  return blockers
}

function hasComment(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  const text = sourceFile.text.slice(node.getStart(sourceFile), node.getEnd())
  let found = false
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, sourceFile.languageVariant, text)
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      found = true
      break
    }
  }
  return found
}

function hasSiblingNamed(site: ConditionalSpreadSite, sourceFile: ts.SourceFile, nameText: string): boolean {
  const target = propertyKey(nameText)
  if (site.kind === 'object') return site.siblings.some((sibling) =>
      (ts.isPropertyAssignment(sibling) || ts.isShorthandPropertyAssignment(sibling) || ts.isMethodDeclaration(sibling)) &&
      sibling.name !== undefined &&
      propertyKey(sibling.name.getText(sourceFile)) === target
    )
  return site.siblings.some((sibling) => ts.isJsxAttribute(sibling) && sibling.name.getText(sourceFile) === target)
}

/** `'aria-label'` 与 `aria-label`、`"k"` 与 `k` 视为同名。 */
function propertyKey(nameText: string): string {
  const quoted = /^(['"])(.*)\1$/su.exec(nameText)
  return quoted?.[2] ?? nameText
}

/** JSX 属性名：标识符或带连字符/命名空间的名字；字符串字面量属性名去引号后必须满足同样形状。 */
function jsxAttributeName(nameText: string): string | undefined {
  const name = propertyKey(nameText)
  return /^[A-Za-z_$][\w$-]*(?::[\w$-]+)?$/u.test(name) ? name : undefined
}

/** 改写目标：对象里是 `k: value`（能简写时写 `k`），JSX 里是 `k={value}`。 */
function formatTarget(kind: ConditionalSpreadSite['kind'], property: SingleProperty, valueText: string): string | undefined {
  if (kind === 'jsx') {
    const name = jsxAttributeName(property.nameText)
    return name ? `${name}={${valueText}}` : undefined
  }
  if (!property.computed && /^[A-Za-z_$][\w$]*$/u.test(property.nameText) && property.nameText === valueText) return property.nameText
  return `${property.nameText}: ${valueText}`
}

function buildAdvice(
  site: ConditionalSpreadSite,
  property: SingleProperty,
  replacement: Replacement,
  target: string | undefined,
  blockers: readonly string[]
): string {
  const parts: string[] = []
  if (property.computed) {
    parts.push('动态键请先构造对象，再用 if 按条件赋值。')
  } else if (target) {
    parts.push(`请写成 \`${target}\`。`)
  }
  if (replacement.truthinessSelf) parts.push(
      '原写法把 \'\'/0/false 也当成缺席：值可能是这些且原意要丢掉时，保留判断（如 `optionalWhen(isTrue, v)` / `optionalWhen(isPositiveNumber, v)`）。'
    )
  if (!replacement.exact && !replacement.truthinessSelf) parts.push('取值依赖条件成立（可选成员、函数调用、有副作用）时改用 `optionalWhenLazy(cond, () => value)`。')
  if (blockers.includes('earlier-spread')) parts.push(
      site.kind === 'jsx'
        ? '前面已有展开属性：直接写属性会用 undefined 盖掉展开出来的同名属性，确认后再改。'
        : '同一对象前面已有展开：直接写字段会用 undefined 盖掉展开出来的同名字段，需要保留时写 `k: cond ? v : base.k`，或先构造对象再用 if 赋值。'
    )
  parts.push('对象用于请求头、URLSearchParams、环境变量或按键枚举时「键缺席」与「undefined」不等价，改为先构造对象再用 if 赋值；两个及以上字段整组出现/缺席时可以保留条件展开。')
  return parts.join('')
}

function fixReplaceText(
  relativePath: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  replacement: string,
  helpers: HelperImportSources
): (ctx: FixContext) => void {
  return fixReplaceSpan({
    relativePath,
    start: node.getStart(sourceFile),
    end: node.getEnd(),
    replacement,
    helpers,
  }).applyFix
}

export { forbidSinglePropertyConditionalSpread }
