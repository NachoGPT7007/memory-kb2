#!/usr/bin/env node
/**
 * scripts/smoke.mjs —— 冒烟测试：不依赖标注数据集，验证「能不能用」。
 *
 * 为什么需要：仓库原来没有 test 脚本，`npm test` 直接报 Missing script；
 * 而 selfcheck 依赖标注集与真实库，新克隆下来的仓库跑不了。
 * 本脚本只用临时目录与虚构数据，验证核心链路：
 *   路径真源 → 常量真源 → 写卡 → 增量索引 → 检索 → 一致性
 *
 * 用法：node scripts/smoke.mjs
 * 退出码：0 全通过 / 1 有失败
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kb2-smoke-'))
process.env.MEM_VAULT = tmp

try {
  // ---- 1. 路径真源 ----
  console.log('\n[1/6] 路径真源')
  const paths = await import(path.join(ROOT, 'src/paths.mjs'))
  const v = paths.resolveVault()
  check('resolveVault 返回 MEM_VAULT', v === tmp, v)
  check('resolveDbPath 在 vault 下', paths.resolveDbPath().startsWith(tmp))
  check('resolveStampPath 在 vault 下', paths.resolveStampPath().startsWith(tmp))

  // ---- 2. 常量真源 ----
  console.log('\n[2/6] 常量真源')
  const c = await import(path.join(ROOT, 'src/constants.mjs'))
  check('EMBED_MODEL 非空', typeof c.EMBED_MODEL === 'string' && c.EMBED_MODEL.length > 0, c.EMBED_MODEL)
  check('WEAK_COS 在 (0,1)', c.WEAK_COS > 0 && c.WEAK_COS < 1, String(c.WEAK_COS))
  check('EMBED_DIM 为正整数', Number.isInteger(c.EMBED_DIM) && c.EMBED_DIM > 0, String(c.EMBED_DIM))

  // ---- 3. 写卡 ----
  console.log('\n[3/6] 写卡')
  const idx = await import(path.join(ROOT, 'src/index.mjs'))
  // 仓库本身不含写卡逻辑（写卡在 DSH 插件侧）。这里直接落一个合规的 Markdown 卡，
  // 验证的是「索引能否正确读取并切分一张卡」，不依赖插件。
  const dir = path.join(tmp, '03-Knowledge')
  await fs.mkdir(dir, { recursive: true })
  const cardFile = path.join(dir, '虚构冒烟测试卡.md')
  await fs.writeFile(cardFile, [
    '---',
    'formatVersion: 2',
    'kind: knowledge',
    'title: 虚构冒烟测试卡',
    'tags: [冒烟, 虚构]',
    'status: approved',
    'atoms:',
    '  - id: smoke1',
    '    text: 这是一条完全虚构的判断，用于验证索引与检索链路是否可用',
    '    nature: fact',
    '    subject: knowledge',
    '    active: true',
    '---',
    '',
    '# 虚构冒烟测试卡',
    '',
    '## 结论',
    '- 完全虚构的正文内容，不含任何真实数据。',
    '',
  ].join('\n'), 'utf8')
  const exists = await fs.stat(cardFile).then(() => true).catch(() => false)
  check('虚构卡写入磁盘', exists)

  // ---- 4. 增量索引 ----
  console.log('\n[4/6] 增量索引')
  const s1 = await idx.sync()
  check('首次 sync 收录卡片', s1.nCards === 1, `nCards=${s1.nCards} nAtoms=${s1.nAtoms} ${s1.ms}ms`)
  const s2 = await idx.sync()
  check('无变化时零变更', s2.added === 0 && s2.updated === 0 && s2.deleted === 0 && s2.skipped === 1,
    `added=${s2.added} skipped=${s2.skipped}`)

  // 新增第二张
  await fs.writeFile(path.join(dir, '虚构第二张.md'), [
    '---', 'formatVersion: 2', 'kind: mistake', 'title: 虚构第二张', 'tags: [冒烟]',
    'status: approved', 'atoms:',
    '  - id: smoke2', '    text: 第二条完全虚构的判断，用于验证增量只处理新增卡片', '    nature: fact', '    subject: knowledge', '    active: true',
    '---', '', '# 虚构第二张', '', '## 要点', '- 完全虚构。', '',
  ].join('\n'), 'utf8')
  const s3 = await idx.sync()
  check('新增只处理 1 张', s3.added === 1 && s3.skipped === 1, `added=${s3.added} skipped=${s3.skipped}`)

  // 删除第二张
  await fs.rm(path.join(dir, '虚构第二张.md'), { force: true })
  const s4 = await idx.sync()
  check('删除只处理 1 张', s4.deleted === 1, `deleted=${s4.deleted} nCards=${s4.nCards}`)

  // ---- 5. 检索 ----
  console.log('\n[5/6] 检索')
  const q = idx.query('虚构冒烟测试 索引链路', { limit: 3 })
  check('检索有命中', (q.ranked?.length ?? 0) > 0, `${q.ranked?.length ?? 0} 条`)
  check('top1 是目标卡', String(q.ranked?.[0]?.title ?? '').includes('虚构冒烟测试卡'), q.ranked?.[0]?.title ?? '无')

  // ---- 6. 一致性 ----
  console.log('\n[6/6] 索引一致性')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(paths.resolveDbPath(), { readOnly: true })
  const nCards = db.prepare('SELECT COUNT(*) c FROM cards').get().c
  const nOrphanAtom = db.prepare('SELECT COUNT(*) c FROM atoms WHERE card_id NOT IN (SELECT id FROM cards)').get().c
  const nOrphanPost = db.prepare('SELECT COUNT(*) c FROM postings WHERE atom_id NOT IN (SELECT id FROM atoms)').get().c
  db.close()
  check('索引卡数 = 磁盘卡数', nCards === 1, `索引 ${nCards}`)
  check('无孤立原子', nOrphanAtom === 0, String(nOrphanAtom))
  check('无孤立倒排项', nOrphanPost === 0, String(nOrphanPost))
} catch (error) {
  console.error('\n冒烟测试异常：', error)
  results.push({ name: '未捕获异常', ok: false, detail: String(error?.message || error) })
} finally {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} —— ${results.length - failed.length}/${results.length} 项通过`)
if (failed.length) {
  for (const f of failed) console.log(`  失败：${f.name} ${f.detail}`)
}
process.exit(failed.length === 0 ? 0 : 1)
