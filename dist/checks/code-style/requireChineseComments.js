import { defineCheck } from '../../core/defineCheck.js';
import ts from 'typescript';
import { collectChineseTextFiles, getCachedSourceFile, walk } from './_shared.js';
const EnglishWordPattern = /[A-Za-z][A-Za-z'-]*/g;
const CjkTextPattern = /[\u3400-\u9FFF]/;
const EnglishProseWordThreshold = 5;
const MixedTextEnglishRunThreshold = 6;
/**
 * 一个「散文词」：字母开头、其余小写（允许撇号/连字符），可带一个句读标点。
 * 标识符（下划线、冒号、点、数字、驼峰、全大写）、中文、斜杠列表都不是散文词，会打断连续计数。
 */
const EnglishProseTokenPattern = /^[A-Za-z][a-z'-]*[,.;:!?]?$/u;
/**
 * 注释和散文式字符串说明文案要求使用团队语言（默认中文）。
 *
 * 启发式判定"算英文说明文案"：
 *   - 全大写常量名（XXX_YYY）不算
 *   - 单 token、像路径/标识符/版本号的不算
 *   - 至少要有 ENGLISH_PROSE_WORD_THRESHOLD 个英文 word（> 1 字符）
 *   - 如果同时含中文，只有出现连续 MIXED_TEXT_ENGLISH_RUN_THRESHOLD 个英文 word 的整句英文才报：
 *     中文段里零散的技术词（args、truncate、payload…）再多也不算，长中文注释不会因为术语多而误伤
 *
 * 跳过 module specifier、property name、纯类型上下文的字符串字面量。
 *
 * **分档豁免**（option `exemptExportedJsDoc`，默认开）：挂在 **导出声明**（及其成员）上的
 * `/** *\/` JSDoc 块不受本规则约束——那是写给外部消费者看的 API 文档，用英文是有意为之；
 * 实现体内部的注释仍须团队语言。Markdown 文档（README / docs / CHANGELOG）本就不在扫描面内。
 */
const requireChineseComments = defineCheck({
    id: 'code-style/require-chinese-comments',
    title: 'Require Chinese in explanatory comments and strings',
    description: '说明性注释与散文式字符串文案必须使用中文（技术词可保留少量英文）；公开 API 的 JSDoc 块豁免。',
    verifies: [
        '扫描所有注释；只在被判为"英文 prose"时报告。',
        '导出声明（及其成员）的 JSDoc 块默认豁免，可用 option `exemptExportedJsDoc: false` 关掉。',
        '扫描所有 string literal / no-substitution template；跳过 import/export/property name/纯类型场景。',
    ],
    tags: ['code-style', 'i18n', 'documentation'],
    defaultSeverity: 'warning',
    run({ context, report }) {
        const section = report.section('Chinese explanatory text');
        const scanStrings = context.options.scanStrings === true;
        const exemptExportedJsDoc = context.options.exemptExportedJsDoc !== false;
        for (const info of collectChineseTextFiles(context)) {
            const sourceFile = getCachedSourceFile(context, info);
            const exemptPositions = exemptExportedJsDoc
                ? collectExportedJsDocPositions(sourceFile)
                : new Set();
            scanComments(sourceFile, info.relativePath, section, exemptPositions);
            if (scanStrings) {
                walk(sourceFile, (node) => scanStringLiteralNode(sourceFile, info.relativePath, node, section));
            }
        }
    },
});
function scanComments(sourceFile, relativePath, section, exemptPositions) {
    // 裸 scanner 不会恢复模板插值后的文本模式，也无法独立区分正则与除法。
    // 复用已解析 AST 的字面量边界，只跳过文本 token，插值表达式中的真实注释照常扫描。
    const literalEnds = new Map();
    walk(sourceFile, (node) => {
        if (ts.isStringLiteralLike(node) ||
            ts.isTemplateLiteralToken(node) ||
            ts.isRegularExpressionLiteral(node) ||
            ts.isJsxText(node)) {
            // JSX 空白文本的 getStart() 会落在 end；使用原始起点并排除缺失的零宽 token。
            const start = ts.isJsxText(node) ? node.pos : node.getStart(sourceFile);
            if (node.end > start)
                literalEnds.set(start, node.end);
        }
    });
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, 
    /* skipTrivia */ false, sourceFile.languageVariant, sourceFile.text);
    while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
        const literalEnd = literalEnds.get(scanner.getTokenPos());
        if (literalEnd !== undefined) {
            scanner.setTextPos(literalEnd);
            continue;
        }
        const token = scanner.getToken();
        if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) {
            continue;
        }
        if (exemptPositions.has(scanner.getTokenPos()))
            continue;
        const text = normalizeCommentText(scanner.getTokenText());
        emitIfEnglishProse(sourceFile, relativePath, scanner.getTokenPos(), 'comment', text, section);
    }
}
/**
 * 收集「公开 API JSDoc」的注释起始位置。
 *
 * 覆盖面：带 `export` 修饰符的声明、被顶层 `export { … }` 点名的声明，以及这些声明
 * **直接成员**（interface 字段、class 方法、enum 成员等）的 JSDoc。实现体内部的注释不在其中。
 */
function collectExportedJsDocPositions(sourceFile) {
    const exportedNames = collectNamedExportIdentifiers(sourceFile);
    const positions = new Set();
    for (const statement of sourceFile.statements) {
        if (!isExportedDeclaration(statement, exportedNames))
            continue;
        addJsDocPositions(sourceFile, statement, positions);
        for (const member of readDeclarationMembers(statement)) {
            addJsDocPositions(sourceFile, member, positions);
        }
    }
    return positions;
}
function collectNamedExportIdentifiers(sourceFile) {
    const names = new Set();
    for (const statement of sourceFile.statements) {
        if (!ts.isExportDeclaration(statement) || !statement.exportClause)
            continue;
        if (!ts.isNamedExports(statement.exportClause))
            continue;
        for (const element of statement.exportClause.elements) {
            names.add((element.propertyName ?? element.name).text);
        }
    }
    return names;
}
function isExportedDeclaration(statement, exportedNames) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
        return true;
    return declaredNames(statement).some((name) => exportedNames.has(name));
}
function declaredNames(statement) {
    if (ts.isVariableStatement(statement)) {
        return statement.declarationList.declarations
            .filter((declaration) => ts.isIdentifier(declaration.name))
            .map((declaration) => declaration.name.text);
    }
    if ((ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
        statement.name) {
        return [statement.name.text];
    }
    return [];
}
function readDeclarationMembers(statement) {
    if (ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement))
        return statement.members;
    if (ts.isEnumDeclaration(statement))
        return statement.members;
    if (ts.isTypeAliasDeclaration(statement) && ts.isTypeLiteralNode(statement.type)) {
        return statement.type.members;
    }
    return [];
}
function addJsDocPositions(sourceFile, node, positions) {
    const ranges = ts.getLeadingCommentRanges(sourceFile.text, node.getFullStart()) ?? [];
    for (const range of ranges) {
        if (range.kind !== ts.SyntaxKind.MultiLineCommentTrivia)
            continue;
        if (!sourceFile.text.startsWith('/**', range.pos))
            continue;
        positions.add(range.pos);
    }
}
function scanStringLiteralNode(sourceFile, relativePath, node, section) {
    if (!isInspectableStringLiteral(node))
        return;
    const text = ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
    if (text === undefined)
        return;
    emitIfEnglishProse(sourceFile, relativePath, node.getStart(sourceFile), 'string', text, section);
}
function emitIfEnglishProse(sourceFile, relativePath, position, kind, text, section) {
    if (!isEnglishProse(text))
        return;
    const line = sourceFile.getLineAndCharacterOfPosition(position).line + 1;
    const preview = normalize(text).slice(0, 120);
    const label = kind === 'comment' ? '注释' : '字符串';
    section.add({
        ruleId: `english-${kind}`,
        file: relativePath,
        line,
        message: `${relativePath}:${line}: ${label}包含英文说明文案 "${preview}"。说明文案必须使用中文；必要时只保留少量技术英文词。`,
        fingerprintInput: `${relativePath}::${kind}::${preview}`,
    });
}
function isEnglishProse(value) {
    const normalized = normalize(value);
    if (!normalized)
        return false;
    if (isCodeLikeText(normalized))
        return false;
    if (/^[A-Z0-9_]+$/.test(normalized))
        return false;
    if (!/\s/.test(normalized) && /^[\w@./:#-]+$/.test(normalized))
        return false;
    const proseText = stripTechnicalFragments(normalized);
    if (!proseText)
        return false;
    const wordCount = countEnglishWords(proseText);
    if (wordCount < EnglishProseWordThreshold)
        return false;
    if (!CjkTextPattern.test(proseText))
        return true;
    return longestEnglishRun(proseText) >= MixedTextEnglishRunThreshold;
}
/** 混排文本里最长的一段连续英文散文有几个词（按空白切词；单字母词不计数也不打断）。 */
function longestEnglishRun(value) {
    let longest = 0;
    let current = 0;
    for (const token of value.split(/\s+/u)) {
        if (!EnglishProseTokenPattern.test(token)) {
            current = 0;
            continue;
        }
        if (token.replace(/[,.;:!?]$/u, '').length > 1)
            current += 1;
        longest = Math.max(longest, current);
    }
    return longest;
}
function countEnglishWords(value) {
    return [...value.matchAll(EnglishWordPattern)].filter((match) => match[0].length > 1).length;
}
function normalize(value) {
    return value.replaceAll(/\s+/g, ' ').trim();
}
function isCodeLikeText(value) {
    return (/\bimport\s+[\s\S]*\bfrom\b/.test(value) ||
        /\bexport\s+(?:function|const|class|type|interface)\b/.test(value) ||
        /^[{[]/.test(value) ||
        /=>|<\/?[A-Z][A-Za-z0-9]*(?:\s|>|\/>)/.test(value));
}
function stripTechnicalFragments(value) {
    return value
        .replaceAll(/`[^`]*`/g, ' ')
        .replaceAll(/['"](?:@?[\w./:-]+|[A-Za-z_$][\w$]*)['"]/g, ' ')
        .replaceAll(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/g, ' ')
        .replaceAll(/\b[A-Za-z_$][\w$]*\([^)]*\)/g, ' ')
        .replaceAll(/\b[A-Z][A-Za-z0-9_]*(?:[A-Z][a-z0-9]+)+\b/g, ' ')
        .replaceAll(/\s+/g, ' ')
        .trim();
}
function normalizeCommentText(raw) {
    return raw
        .replace(/^\/\//, '')
        .replace(/^\/\*/, '')
        .replace(/\*\/$/, '')
        .split('\n')
        .map((line) => line.replace(/^\s*\*\s?/, '').trim())
        .join(' ');
}
function isInspectableStringLiteral(node) {
    if (!ts.isStringLiteralLike(node) && !ts.isNoSubstitutionTemplateLiteral(node))
        return false;
    if (isModuleSpecifier(node))
        return false;
    if (isPropertyName(node))
        return false;
    if (isOnlyInTypeContext(node))
        return false;
    return true;
}
function isModuleSpecifier(node) {
    const parent = node.parent;
    if (!parent)
        return false;
    if (ts.isImportDeclaration(parent) && parent.moduleSpecifier === node)
        return true;
    if (ts.isExportDeclaration(parent) && parent.moduleSpecifier === node)
        return true;
    if (ts.isImportTypeNode(parent) && parent.argument === node)
        return true;
    return false;
}
function isPropertyName(node) {
    const parent = node.parent;
    if (!parent)
        return false;
    return ((ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isPropertyDeclaration(parent) && parent.name === node) ||
        (ts.isMethodDeclaration(parent) && parent.name === node) ||
        (ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
        (ts.isSetAccessorDeclaration(parent) && parent.name === node));
}
function isOnlyInTypeContext(node) {
    let current = node.parent;
    while (current) {
        if (ts.isLiteralTypeNode(current) ||
            ts.isTypeReferenceNode(current) ||
            ts.isUnionTypeNode(current) ||
            ts.isTypeAliasDeclaration(current) ||
            ts.isInterfaceDeclaration(current))
            return true;
        if (ts.isExpressionStatement(current) ||
            ts.isVariableDeclaration(current) ||
            ts.isReturnStatement(current))
            return false;
        current = current.parent;
    }
    return false;
}
export { requireChineseComments };
//# sourceMappingURL=requireChineseComments.js.map