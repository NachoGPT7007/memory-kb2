#!/usr/bin/env node
// 原子质量分类规则 · 边界测试
//
// 目的不是追求覆盖，而是钉住几条容易漂的边界：
//   - 箭头流程必须判 needs_rewrite（normalizeCard 本来就丢弃这类原子，历史卡里却大量存在）
//   - 列表符号开头必须判（原本是「标题列表被当原子」那类）
//   - 正常的一两句判断不能误伤（误判会让人不信这份报告）

import { classifyAtom } from './audit-atoms.mjs'

const checks = []
let pass = 0
const ok = (name, cond, extra = '') => {
  checks.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (cond) pass++
}

const v = (t, n) => classifyAtom(t, { nature: n }).verdict

// --- 应该 pass ---
ok('普通事实判断 pass', v('memory-kb2 的 MCP 服务监听端口是 7999') === 'pass')
ok('带数字的事实 pass', v('索引全量构建 520 卡耗时 964 毫秒') === 'pass')
ok('边界/禁止类 pass', v('配置真源是 cordis.patch.yml，不要改那个 JSON') === 'pass')
ok('偏长但仍是一句 pass', v('写入设置校验记录 schema 与 tokenizer，二者任一变化都必须全量重建索引，否则检索结果会静默错误') === 'pass')

// --- 应该 needs_rewrite ---
ok('箭头流程', v('客户端 → 设置 → 云同步，看是否带锁') === 'needs_rewrite')
ok('列表符号开头', v('- 登录后看到脱敏界面就说明 ingress 已经生效') === 'needs_rewrite')
ok('编号开头', v('1. 浏览器打开后台先跳访问登录页') === 'needs_rewrite')
// 「的」结尾现在不判（中文「是…的」完整句太多）。用真正的半截句：以连接词/标点收尾。
ok('半截句-以「和」结尾', v('这个配置同时还依赖路径解析与凭据查找和') === 'needs_rewrite')
ok('半截句-以「：」结尾', v('根因有三个：') === 'needs_rewrite')
ok('标题后接清单', v('三个坑：路径解析、凭据缺失、索引落后') === 'needs_rewrite')
ok('过短无信息', v('不行') === 'needs_rewrite')

// --- 应该 too_coarse ---
ok('超长原子', v('这是一条非常长的原子，'.repeat(12)) === 'too_coarse')
ok('多段并列', v('第一件事要确认端口，；第二件事要确认路径，；第三件事要确认凭据，；第四件事要确认索引，；第五件事要确认缓存，够长了。'.slice(0, 100)) === 'too_coarse')

// --- 边界：不应该因为含中文冒号就误判 ---
ok('冒号但非清单 pass', v('根因：插件进程没有继承父进程的 DSH_HOME 环境变量') === 'pass')

console.log(checks.join('\n'))
console.log(`\n${pass}/${checks.length} 通过`)
process.exit(pass === checks.length ? 0 : 1)
