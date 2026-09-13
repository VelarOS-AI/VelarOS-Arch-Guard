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
declare const requireChineseComments: import("../../index.js").Check;
export { requireChineseComments };
//# sourceMappingURL=requireChineseComments.d.ts.map