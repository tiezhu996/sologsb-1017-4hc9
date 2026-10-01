// 三方合并引擎验证：node scripts/run-merge-tests.mjs
// 用 esbuild（vite 自带）把 TS 源码打成临时 ESM 后直接在 node 中跑断言。
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(root, 'node_modules', '.tmp', 'merge-test-bundle.mjs')

await build({
  entryPoints: [path.join(root, 'src', 'merge.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'silent'
})

const { computeMerge, buildMergedScript, buildMergedReviews, unresolvedConflicts } = await import(outfile)

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`  ✗ ${name}\n    ${error?.stack?.split('\n').slice(0, 3).join('\n    ')}`)
  }
}
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const clone = (value) => structuredClone(value)

// ---- 夹具：围绕 sample 结构的最小剧本 ----
function makeScript() {
  return {
    title: '剧本', writer: '作者', draft: '一稿',
    characters: [
      { id: 'c1', name: '林默', actor: '甲', introducedSceneId: 's1', note: '' },
      { id: 'c2', name: '苏遥', actor: '乙', introducedSceneId: 's2', note: '' }
    ],
    props: [
      { id: 'p1', name: '录音笔', introducedSceneId: 's1', ownerId: 'c1', note: '' }
    ],
    wardrobes: [
      { id: 'w1', characterId: 'c1', name: '夹克', timePeriods: ['夜'], note: '' }
    ],
    scenes: [
      {
        id: 's1', number: '1', slug: '堤岸', synopsis: '开场', intExt: 'EXT', location: '堤岸', dayNight: '夜',
        storyTime: '第 1 天 22:40', pageLength: 2, characterIds: ['c1'], propIds: ['p1'],
        costumes: { c1: 'w1' }, revision: 'white', status: 'draft', reason: ''
      },
      {
        id: 's2', number: '2', slug: '维修铺', synopsis: '苏遥无铺垫出现', intExt: 'INT', location: '铺子', dayNight: '夜',
        storyTime: '第 1 天 23:20', pageLength: 1, characterIds: ['c1', 'c2'], propIds: ['p1'],
        costumes: { c1: 'w1' }, revision: 'blue', status: 'draft', reason: ''
      }
    ]
  }
}
const base = { script: makeScript(), reviews: {}, versions: [], savedAt: new Date().toISOString() }
// c2 的首次建立场景是 s2，却在 s2（index 1）第一次出现，会产生 character-s2-c2 警告
const WARN_C2 = 'character-s2-c2'

console.log('一、无冲突改动自动合入')
test('甲改场名 + 新增道具，乙只改审阅：零冲突、剧本取甲、决定保留', () => {
  const scriptA = makeScript(); scriptA.scenes[0].slug = '堤岸·雨夜'
  scriptA.props.push({ id: 'p2', name: '船票', introducedSceneId: 's1', ownerId: 'c1', note: '' })
  const reviewsB = { [WARN_C2]: { status: 'ignored', replies: [{ id: 'r1', author: '乙', text: '声音已铺垫', createdAt: '2026-09-30T10:00:00Z' }] } }
  const plan = computeMerge({ base, scriptA, scriptB: makeScript(), reviewsA: {}, reviewsB })
  assert(plan.conflicts.length === 0, `不应有冲突，实际 ${plan.conflicts.length}`)
  assert(plan.autoChanges.some((c) => c.entity === 'scene' && c.kind === 'modified' && c.side === 'a'), '甲的场名修改应自动合入')
  assert(plan.autoChanges.some((c) => c.entity === 'prop' && c.kind === 'added'), '甲的新道具应自动合入')
  const merged = buildMergedScript(base.script, scriptA, makeScript(), plan.conflicts)
  assert(merged.scenes[0].slug === '堤岸·雨夜', '合并稿应采用甲的场名')
  assert(merged.props.some((p) => p.id === 'p2'), '合并稿应包含新道具')
  const { reviews } = buildMergedReviews(base, scriptA, makeScript(), merged, {}, reviewsB, plan.conflicts)
  assert(reviews[WARN_C2]?.status === 'ignored', '乙的忽略决定应跟随同一警告')
  assert(reviews[WARN_C2].replies[0].text === '声音已铺垫', '乙的回复应保留')
})

test('同一场景甲改场名、乙改摘要：互不打架，两字段都自动合入', () => {
  const scriptA = makeScript(); scriptA.scenes[0].slug = '新场名'
  const scriptB = makeScript(); scriptB.scenes[0].synopsis = '新摘要'
  const plan = computeMerge({ base, scriptA, scriptB, reviewsA: {}, reviewsB: {} })
  assert(plan.conflicts.length === 0, '同对象不同字段不应冲突')
  const merged = buildMergedScript(base.script, scriptA, scriptB, plan.conflicts)
  assert(merged.scenes[0].slug === '新场名' && merged.scenes[0].synopsis === '新摘要', '两版字段都应进入合并稿')
})

console.log('二、同一字段两边都改：保留两版让人选定')
test('场名双方改得不同 → 1 个字段冲突；未选定不能完成；选定后取相应版本', () => {
  const scriptA = makeScript(); scriptA.scenes[0].slug = '甲版场名'
  const scriptB = makeScript(); scriptB.scenes[0].slug = '乙版场名'
  const plan = computeMerge({ base, scriptA, scriptB, reviewsA: {}, reviewsB: {} })
  assert(plan.conflicts.length === 1, '应有 1 个冲突')
  assert(plan.conflicts[0].fields.length === 1 && plan.conflicts[0].fields[0].key === 'slug', '冲突字段应为 slug')
  assert(unresolvedConflicts(plan.conflicts).length === 1, '初始应未选定')
  let threw = false
  try { buildMergedScript(base.script, scriptA, scriptB, plan.conflicts) } catch { threw = true }
  assert(threw, '未选定时构建合并稿应失败')
  plan.conflicts[0].fields[0].resolution = 'b'
  assert(unresolvedConflicts(plan.conflicts).length === 0, '选定后应无未决项')
  const merged = buildMergedScript(base.script, scriptA, scriptB, plan.conflicts)
  assert(merged.scenes[0].slug === '乙版场名', '选乙版应取乙版场名')
})

console.log('三、删除与修改互撞交人决定')
test('甲删场景、乙改同场景 → 整条冲突：选乙保留，选甲删除', () => {
  const scriptA = makeScript(); scriptA.scenes = scriptA.scenes.filter((s) => s.id !== 's2')
  const scriptB = makeScript(); scriptB.scenes[1].slug = '维修铺·录音'
  const plan = computeMerge({ base, scriptA, scriptB, reviewsA: {}, reviewsB: {} })
  const conflict = plan.conflicts.find((c) => c.id === 's2')
  assert(conflict && conflict.reason === 'removed-vs-modified', '应为 删除-vs-修改 冲突')
  conflict.resolution = 'b'
  let merged = buildMergedScript(base.script, scriptA, scriptB, plan.conflicts)
  assert(merged.scenes.some((s) => s.id === 's2' && s.slug === '维修铺·录音'), '选乙应保留乙修改后的场景')
  conflict.resolution = 'a'
  merged = buildMergedScript(base.script, scriptA, scriptB, plan.conflicts)
  assert(!merged.scenes.some((s) => s.id === 's2'), '选甲应确认删除')
})

test('双方都删除 → 自动删除，不产生冲突', () => {
  const scriptA = makeScript(); scriptA.scenes = scriptA.scenes.filter((s) => s.id !== 's2')
  const scriptB = makeScript(); scriptB.scenes = scriptB.scenes.filter((s) => s.id !== 's2')
  const plan = computeMerge({ base, scriptA, scriptB, reviewsA: {}, reviewsB: {} })
  assert(plan.conflicts.length === 0, '双方删除不应冲突')
  assert(plan.autoChanges.some((c) => c.id === 's2' && c.kind === 'removed'), '应记录自动删除')
})

console.log('四、警告和回复跟随自己的版本，不套到新场景')
test('乙在警告上做决定，但合并稿中该警告已消失 → 进脱离清单；新场景的新警告不继承决定', () => {
  // 甲删除 s2（WARN_C2 随之消失），并新增 s3；s3 上 c2 无铺垫出现会产生新的 character-s3-c2 警告
  const scriptA = makeScript()
  scriptA.scenes = scriptA.scenes.filter((s) => s.id !== 's2')
  scriptA.scenes.push({
    id: 's3', number: '3', slug: '码头', synopsis: '新场景', intExt: 'EXT', location: '码头', dayNight: '夜',
    storyTime: '第 2 天 08:00', pageLength: 1, characterIds: ['c2'], propIds: [],
    costumes: {}, revision: 'white', status: 'draft', reason: ''
  })
  const scriptB = makeScript()
  const reviewsB = {
    [WARN_C2]: { status: 'accepted', replies: [{ id: 'r9', author: '乙', text: '已确认', createdAt: '2026-09-30T11:00:00Z' }] }
  }
  const plan = computeMerge({ base, scriptA, scriptB, reviewsA: {}, reviewsB })
  const merged = buildMergedScript(base.script, scriptA, scriptB, plan.conflicts)
  const { reviews, orphanReviews } = buildMergedReviews(base, scriptA, scriptB, merged, {}, reviewsB, plan.conflicts)
  assert(!reviews[WARN_C2], '消失的警告决定不能挂回合并稿')
  assert(!reviews['character-s3-c2'], '新场景的新警告绝不能继承旧决定')
  assert(orphanReviews.some((o) => o.warningId === WARN_C2 && o.review.status === 'accepted'), '旧决定应进入脱离清单保留')
})

test('警告仍存在 → 乙的接受/回复跟随，且不串场号', () => {
  const scriptA = makeScript(); scriptA.scenes[0].slug = '只动第一场'
  const reviewsB = { [WARN_C2]: { status: 'accepted', replies: [], updatedAt: '2026-09-30T12:00:00Z' } }
  const plan = computeMerge({ base, scriptA, scriptB: makeScript(), reviewsA: {}, reviewsB })
  const merged = buildMergedScript(base.script, scriptA, makeScript(), plan.conflicts)
  const { reviews, orphanReviews } = buildMergedReviews(base, scriptA, makeScript(), merged, {}, reviewsB, plan.conflicts)
  assert(reviews[WARN_C2]?.status === 'accepted', '同一警告 id 仍在 → 决定跟随')
  assert(orphanReviews.length === 0, '警告仍在时不应有脱离决定')
})

console.log('五、审阅状态双方打架也让人选定；回复按 id 并集保留')
test('同一警告甲接受、乙忽略 → review 冲突；选定后状态统一、两边回复都在', () => {
  const script = makeScript()
  const reviewsA = { [WARN_C2]: { status: 'accepted', replies: [{ id: 'ra', author: '甲', text: '接受', createdAt: '2026-09-30T10:00:00Z' }] } }
  const reviewsB = { [WARN_C2]: { status: 'ignored', replies: [{ id: 'rb', author: '乙', text: '忽略', createdAt: '2026-09-30T10:05:00Z' }] } }
  const plan = computeMerge({ base, scriptA: script, scriptB: clone(script), reviewsA, reviewsB })
  const conflict = plan.conflicts.find((c) => c.entity === 'review' && c.id === WARN_C2)
  assert(conflict, '应产生审阅状态冲突')
  assert(unresolvedConflicts(plan.conflicts).length === 1, '审阅冲突初始应未决')
  let threw = false
  try { buildMergedReviews(base, script, clone(script), script, reviewsA, reviewsB, plan.conflicts) } catch { threw = true }
  assert(threw, '审阅冲突未选定应失败')
  conflict.fields[0].resolution = 'a'
  const { reviews } = buildMergedReviews(base, script, clone(script), script, reviewsA, reviewsB, plan.conflicts)
  assert(reviews[WARN_C2].status === 'accepted', '选甲版应取接受')
  const replyTexts = reviews[WARN_C2].replies.map((r) => r.text)
  assert(replyTexts.includes('接受') && replyTexts.includes('忽略'), '双方回复应按并集保留')
})

rmSync(outfile, { force: true })

console.log(`\n${failures.length ? `❌ ${failures.length} 项失败：${failures.join('；')}` : `全部 ${passed} 项通过 ✅`}`)
process.exit(failures.length ? 1 : 0)
