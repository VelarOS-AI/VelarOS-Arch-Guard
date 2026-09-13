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
declare const forbidSinglePropertyConditionalSpread: import("../../index.js").Check;
export { forbidSinglePropertyConditionalSpread };
//# sourceMappingURL=forbidSinglePropertyConditionalSpread.d.ts.map