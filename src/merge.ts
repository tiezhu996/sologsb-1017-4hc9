import { deriveWarnings } from './checks'
import type {
  AutoChange,
  ConflictSide,
  EntityConflict,
  FieldConflict,
  MergeBase,
  OrphanReview,
  Prop,
  Scene,
  Script,
  Character,
  Wardrobe,
  WarningItem,
  WarningReview
} from './types'

export const SIDE_LABEL: Record<ConflictSide, string> = {
  a: '场记甲 · 场景/道具/服装稿',
  b: '场记乙 · 警告/回复稿'
}

export function deepEqual<T>(left: T, right: T): boolean {
  if (left === right) return true
  if (typeof left !== typeof right || left === null || right === null || typeof left !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((item, index) => deepEqual(item, right[index]))
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => deepEqual(leftRecord[key], rightRecord[key]))
}

const clone = <T,>(value: T): T => structuredClone(value)

interface FieldDef {
  key: string
  label: string
}

const SCENE_FIELDS: FieldDef[] = [
  { key: 'number', label: '场号' },
  { key: 'slug', label: '场名' },
  { key: 'synopsis', label: '摘要' },
  { key: 'intExt', label: '内外景' },
  { key: 'location', label: '地点' },
  { key: 'dayNight', label: '日夜' },
  { key: 'storyTime', label: '故事时间' },
  { key: 'pageLength', label: '页数' },
  { key: 'characterIds', label: '出场角色' },
  { key: 'propIds', label: '出场道具' },
  { key: 'costumes', label: '服装绑定' },
  { key: 'revision', label: '修订色' },
  { key: 'status', label: '场次状态' },
  { key: 'reason', label: '修改理由' }
]
const CHARACTER_FIELDS: FieldDef[] = [
  { key: 'name', label: '姓名' },
  { key: 'actor', label: '演员' },
  { key: 'introducedSceneId', label: '首次建立场景' },
  { key: 'note', label: '备注' }
]
const PROP_FIELDS: FieldDef[] = [
  { key: 'name', label: '道具名' },
  { key: 'introducedSceneId', label: '首次建立场景' },
  { key: 'ownerId', label: '持有人' },
  { key: 'note', label: '备注' }
]
const WARDROBE_FIELDS: FieldDef[] = [
  { key: 'characterId', label: '所属角色' },
  { key: 'name', label: '服装名' },
  { key: 'timePeriods', label: '适用时段' },
  { key: 'note', label: '备注' }
]
const META_FIELDS: FieldDef[] = [
  { key: 'title', label: '剧本标题' },
  { key: 'writer', label: '作者' },
  { key: 'draft', label: '稿次' }
]

type EntityKind = 'scene' | 'character' | 'prop' | 'wardrobe'

interface EntityConfig {
  kind: EntityKind
  collection: (script: Script) => Array<Record<string, unknown>>
  fields: FieldDef[]
  nameOf: (entity: Record<string, unknown> | undefined) => string
}

const sceneName = (entity: Record<string, unknown> | undefined) =>
  entity ? `场景 ${String(entity.number ?? '?')} · ${String(entity.slug ?? '未命名')}` : '（已删除）'
const simpleName = (entity: Record<string, unknown> | undefined) => (entity ? String(entity.name ?? '未命名') : '（已删除）')

const ENTITY_CONFIGS: EntityConfig[] = [
  { kind: 'scene', collection: (script) => script.scenes as unknown as Array<Record<string, unknown>>, fields: SCENE_FIELDS, nameOf: sceneName },
  { kind: 'character', collection: (script) => script.characters as unknown as Array<Record<string, unknown>>, fields: CHARACTER_FIELDS, nameOf: simpleName },
  { kind: 'prop', collection: (script) => script.props as unknown as Array<Record<string, unknown>>, fields: PROP_FIELDS, nameOf: simpleName },
  { kind: 'wardrobe', collection: (script) => script.wardrobes as unknown as Array<Record<string, unknown>>, fields: WARDROBE_FIELDS, nameOf: simpleName }
]

export interface MergeInput {
  base: MergeBase
  scriptA: Script
  scriptB: Script
  reviewsA: Record<string, WarningReview>
  reviewsB: Record<string, WarningReview>
}

export interface MergePlan {
  conflicts: EntityConflict[]
  autoChanges: AutoChange[]
}

type SideValue = 'unchanged' | 'a' | 'b' | 'same' | 'conflict'

function mergeSide(base: unknown, a: unknown, b: unknown): SideValue {
  const aChanged = !deepEqual(base, a)
  const bChanged = !deepEqual(base, b)
  if (!aChanged && !bChanged) return 'unchanged'
  if (aChanged && !bChanged) return 'a'
  if (!aChanged && bChanged) return 'b'
  return deepEqual(a, b) ? 'same' : 'conflict'
}

const isMeaningfulReview = (review: WarningReview | undefined): review is WarningReview =>
  !!review && (review.status !== 'pending' || review.replies.length > 0)

const changedFieldLabels = (fields: FieldDef[], baseItem: Record<string, unknown>, item: Record<string, unknown>) =>
  fields.filter((field) => !deepEqual(baseItem[field.key], item[field.key])).map((field) => field.label)

/**
 * 基于共同原稿的三方合并。
 * 只有一方改动的内容自动合入；同一字段两边都改且内容不同 → 保留两版待人工选定；
 * 一方删除另一方修改同样交人工决定。审阅状态的直接打架也作为字段冲突暴露。
 */
export function computeMerge(input: MergeInput): MergePlan {
  const { base, scriptA, scriptB, reviewsA, reviewsB } = input
  const conflicts: EntityConflict[] = []
  const autoChanges: AutoChange[] = []

  for (const config of ENTITY_CONFIGS) {
    const baseItems = new Map(config.collection(base.script).map((item) => [String(item.id), item]))
    const aItems = new Map(config.collection(scriptA).map((item) => [String(item.id), item]))
    const bItems = new Map(config.collection(scriptB).map((item) => [String(item.id), item]))
    const allIds = new Set([...baseItems.keys(), ...aItems.keys(), ...bItems.keys()])

    for (const entityId of allIds) {
      const baseItem = baseItems.get(entityId)
      const aItem = aItems.get(entityId)
      const bItem = bItems.get(entityId)

      if (baseItem) {
        if (aItem && bItem) {
          if (deepEqual(aItem, bItem)) {
            if (!deepEqual(baseItem, aItem)) {
              autoChanges.push({ entity: config.kind, id: entityId, name: config.nameOf(aItem), kind: 'modified', side: 'a', fields: changedFieldLabels(config.fields, baseItem, aItem) })
            }
            continue
          }
          const fieldConflicts: FieldConflict[] = []
          for (const field of config.fields) {
            if (mergeSide(baseItem[field.key], aItem[field.key], bItem[field.key]) === 'conflict') {
              fieldConflicts.push({ key: field.key, label: field.label, base: clone(baseItem[field.key]), a: clone(aItem[field.key]), b: clone(bItem[field.key]) })
            }
          }
          const aFields = changedFieldLabels(config.fields, baseItem, aItem).filter((label) => !fieldConflicts.some((conflict) => conflict.label === label))
          const bFields = changedFieldLabels(config.fields, baseItem, bItem).filter((label) => !fieldConflicts.some((conflict) => conflict.label === label))
          if (fieldConflicts.length) {
            conflicts.push({
              id: entityId,
              entity: config.kind,
              baseName: config.nameOf(baseItem),
              aName: config.nameOf(aItem),
              bName: config.nameOf(bItem),
              a: clone(aItem),
              b: clone(bItem),
              fields: fieldConflicts
            })
          }
          if (aFields.length) autoChanges.push({ entity: config.kind, id: entityId, name: config.nameOf(aItem), kind: 'modified', side: 'a', fields: aFields })
          if (bFields.length) autoChanges.push({ entity: config.kind, id: entityId, name: config.nameOf(bItem), kind: 'modified', side: 'b', fields: bFields })
        } else {
          const survivor = aItem ?? bItem
          const survivorSide: ConflictSide = aItem ? 'a' : 'b'
          const removedSide: ConflictSide = survivorSide === 'a' ? 'b' : 'a'
          if (!survivor) {
            autoChanges.push({ entity: config.kind, id: entityId, name: config.nameOf(baseItem), kind: 'removed', side: 'a', fields: [] })
          } else if (deepEqual(baseItem, survivor)) {
            autoChanges.push({ entity: config.kind, id: entityId, name: config.nameOf(baseItem), kind: 'removed', side: removedSide, fields: [] })
          } else {
            conflicts.push({
              id: entityId,
              entity: config.kind,
              reason: removedSide === 'a' ? 'removed-vs-modified' : 'modified-vs-removed',
              baseName: config.nameOf(baseItem),
              aName: config.nameOf(aItem),
              bName: config.nameOf(bItem),
              a: clone(aItem),
              b: clone(bItem),
              fields: []
            })
          }
        }
      } else {
        if (aItem && bItem) {
          if (deepEqual(aItem, bItem)) {
            autoChanges.push({ entity: config.kind, id: entityId, name: config.nameOf(aItem), kind: 'added', side: 'a', fields: [] })
          } else {
            conflicts.push({
              id: entityId,
              entity: config.kind,
              reason: 'both-added-differently',
              baseName: '（共同原稿中不存在）',
              aName: config.nameOf(aItem),
              bName: config.nameOf(bItem),
              a: clone(aItem),
              b: clone(bItem),
              fields: config.fields
                .filter((field) => !deepEqual(aItem[field.key], bItem[field.key]))
                .map((field) => ({ key: field.key, label: field.label, base: undefined, a: clone(aItem[field.key]), b: clone(bItem[field.key]) }))
            })
          }
        } else if (aItem) {
          autoChanges.push({ entity: config.kind, id: entityId, name: config.nameOf(aItem), kind: 'added', side: 'a', fields: [] })
        } else {
          autoChanges.push({ entity: config.kind, id: entityId, name: config.nameOf(bItem), kind: 'added', side: 'b', fields: [] })
        }
      }
    }
  }

  // 剧本元信息同字段所有权
  const metaFieldConflicts: FieldConflict[] = []
  for (const field of META_FIELDS) {
    const key = field.key as keyof Script
    if (mergeSide(base.script[key], scriptA[key], scriptB[key]) === 'conflict') {
      metaFieldConflicts.push({ key: field.key, label: field.label, base: clone(base.script[key]), a: clone(scriptA[key]), b: clone(scriptB[key]) })
    }
  }
  if (metaFieldConflicts.length) {
    conflicts.push({
      id: '__script_meta__',
      entity: 'meta',
      baseName: '剧本信息',
      aName: SIDE_LABEL.a,
      bName: SIDE_LABEL.b,
      a: { title: scriptA.title, writer: scriptA.writer, draft: scriptA.draft },
      b: { title: scriptB.title, writer: scriptB.writer, draft: scriptB.draft },
      fields: metaFieldConflicts
    })
  }

  // 审阅状态打架（回复本身按回复 id 并集保留，不产生二选一）
  const titlesA = warningTitleMap(scriptA)
  const titlesB = warningTitleMap(scriptB)
  for (const warningId of new Set([...Object.keys(reviewsA), ...Object.keys(reviewsB)])) {
    const baseStatus = base.reviews[warningId]?.status ?? 'pending'
    const statusA = reviewsA[warningId]?.status ?? 'pending'
    const statusB = reviewsB[warningId]?.status ?? 'pending'
    if (mergeSide(baseStatus, statusA, statusB) === 'conflict') {
      conflicts.push({
        id: warningId,
        entity: 'review',
        baseName: titlesA.get(warningId)?.title ?? titlesB.get(warningId)?.title ?? warningId,
        aName: SIDE_LABEL.a,
        bName: SIDE_LABEL.b,
        a: reviewsA[warningId],
        b: reviewsB[warningId],
        fields: [{ key: 'status', label: '审阅状态', base: baseStatus, a: statusA, b: statusB }]
      })
    }
  }

  return { conflicts, autoChanges }
}

function warningTitleMap(script: Script): Map<string, WarningItem> {
  return new Map(deriveWarnings(script).map((warning) => [warning.id, warning]))
}

/** 冲突是否全部已选定（界面据此放行“完成合并”） */
export function unresolvedConflicts(conflicts: EntityConflict[]): EntityConflict[] {
  return conflicts.filter((conflict) => {
    if (conflict.entity === 'review' || (conflict.fields.length > 0 && conflict.reason === undefined)) {
      return conflict.fields.some((field) => !field.resolution)
    }
    // 整条冲突（新增撞车 / 删除对修改）或 meta：整级或逐字段
    if (conflict.entity === 'meta') return conflict.fields.some((field) => !field.resolution)
    if (conflict.reason === 'both-added-differently') {
      return !conflict.resolution && conflict.fields.some((field) => !field.resolution)
    }
    return !conflict.resolution
  })
}

/** 按用户的选定重建合并后的剧本；尚有未决冲突时抛错。 */
export function buildMergedScript(baseScript: Script, scriptA: Script, scriptB: Script, conflicts: EntityConflict[]): Script {
  const merged = clone(baseScript)
  const conflictOf = (entity: string, id: string) => conflicts.find((conflict) => conflict.entity === entity && conflict.id === id)
  const fail = (message: string): never => { throw new Error(message) }

  for (const config of ENTITY_CONFIGS) {
    const baseItems = new Map(config.collection(baseScript).map((item) => [String(item.id), item]))
    const aItems = new Map(config.collection(scriptA).map((item) => [String(item.id), item]))
    const bItems = new Map(config.collection(scriptB).map((item) => [String(item.id), item]))
    const orderedIds: string[] = []
    for (const item of config.collection(baseScript)) orderedIds.push(String(item.id))
    for (const item of config.collection(scriptA)) if (!orderedIds.includes(String(item.id))) orderedIds.push(String(item.id))
    for (const item of config.collection(scriptB)) if (!orderedIds.includes(String(item.id))) orderedIds.push(String(item.id))

    const target: Array<Record<string, unknown>> = []
    for (const entityId of orderedIds) {
      const baseItem = baseItems.get(entityId)
      const aItem = aItems.get(entityId)
      const bItem = bItems.get(entityId)
      const conflict = conflictOf(config.kind, entityId)

      if (baseItem) {
        if (aItem && bItem) {
          const next = clone(baseItem)
          for (const field of config.fields) {
            const outcome = mergeSide(baseItem[field.key], aItem[field.key], bItem[field.key])
            if (outcome === 'a' || outcome === 'same') next[field.key] = clone(aItem[field.key])
            else if (outcome === 'b') next[field.key] = clone(bItem[field.key])
            else if (outcome === 'conflict') {
              const side = conflict?.fields.find((item) => item.key === field.key)?.resolution
                ?? fail(`unresolved:${config.kind}:${entityId}:${field.key}`)
              next[field.key] = clone((side === 'a' ? aItem : bItem)[field.key])
            }
          }
          target.push(next)
        } else {
          const survivor = aItem ?? bItem
          const survivorSide: ConflictSide = aItem ? 'a' : 'b'
          if (!survivor) continue // 双方删除
          if (deepEqual(baseItem, survivor)) continue // 仅一方删除
          const pick = conflict?.resolution
          if (!pick) fail(`unresolved:${config.kind}:${entityId}`)
          else if (pick === survivorSide) target.push(clone(survivor))
          // 选择删除方 → 不写入
        }
      } else {
        if (aItem && bItem) {
          if (deepEqual(aItem, bItem)) target.push(clone(aItem))
          else {
            // 新增撞 id：允许整级一键选择，也允许逐字段选择；逐字段混合时以 a 版为骨架
            const pick = conflict?.resolution
            if (pick) target.push(clone(pick === 'a' ? aItem : bItem))
            else if (conflict && conflict.fields.every((field) => field.resolution)) {
              const skeleton = clone(aItem)
              for (const field of conflict.fields) {
                if (field.resolution === 'b') skeleton[field.key] = clone(bItem[field.key])
              }
              target.push(skeleton)
            } else fail(`unresolved:${config.kind}:${entityId}`)
          }
        } else if (aItem) target.push(clone(aItem))
        else if (bItem) target.push(clone(bItem))
      }
    }

    if (config.kind === 'scene') merged.scenes = target as unknown as Scene[]
    else if (config.kind === 'character') merged.characters = target as unknown as Character[]
    else if (config.kind === 'prop') merged.props = target as unknown as Prop[]
    else merged.wardrobes = target as unknown as Wardrobe[]
  }

  const metaConflict = conflictOf('meta', '__script_meta__')
  const metaTarget = merged as unknown as Record<string, unknown>
  for (const field of META_FIELDS) {
    const key = field.key as keyof Script
    const outcome = mergeSide(baseScript[key], scriptA[key], scriptB[key])
    if (outcome === 'a' || outcome === 'same') metaTarget[field.key] = clone(scriptA[key])
    else if (outcome === 'b') metaTarget[field.key] = clone(scriptB[key])
    else if (outcome === 'conflict') {
      const side = metaConflict?.fields.find((item) => item.key === field.key)?.resolution ?? fail(`unresolved:meta:${field.key}`)
      metaTarget[field.key] = clone((side === 'a' ? scriptA : scriptB)[key])
    }
  }

  return merged
}

export interface MergedReviews {
  reviews: Record<string, WarningReview>
  orphanReviews: OrphanReview[]
}

/**
 * 审阅决定只跟随合并稿中仍以同一确定性 id 存在的警告；
 * 合并稿新派生的警告不继承旧决定，找不到归属的决定进入脱离清单，绝不按场号套用。
 */
export function buildMergedReviews(
  base: MergeBase,
  scriptA: Script,
  scriptB: Script,
  mergedScript: Script,
  reviewsA: Record<string, WarningReview>,
  reviewsB: Record<string, WarningReview>,
  conflicts: EntityConflict[]
): MergedReviews {
  const mergedWarnings = warningTitleMap(mergedScript)
  const titlesA = warningTitleMap(scriptA)
  const titlesB = warningTitleMap(scriptB)
  const reviews: Record<string, WarningReview> = {}
  const orphanReviews: OrphanReview[] = []

  for (const warningId of new Set([...Object.keys(base.reviews), ...Object.keys(reviewsA), ...Object.keys(reviewsB)])) {
    const baseReview = base.reviews[warningId]
    const reviewA = reviewsA[warningId]
    const reviewB = reviewsB[warningId]
    const aChanged = !deepEqual(baseReview, reviewA)
    const bChanged = !deepEqual(baseReview, reviewB)

    const statusOutcome = mergeSide(baseReview?.status ?? 'pending', reviewA?.status ?? 'pending', reviewB?.status ?? 'pending')
    let status: WarningReview['status']
    if (statusOutcome === 'b') status = reviewB!.status
    else if (statusOutcome === 'conflict') {
      const side = conflicts.find((conflict) => conflict.entity === 'review' && conflict.id === warningId)?.fields[0]?.resolution
      if (!side) throw new Error(`unresolved:review:${warningId}`)
      status = (side === 'a' ? reviewA : reviewB)!.status
    } else status = (reviewA ?? reviewB ?? baseReview)!.status

    const replies = mergeReplies(baseReview, reviewA, reviewB)
    const candidate: WarningReview = { status, replies, updatedAt: latestUpdated(reviewA, reviewB, baseReview) }
    if (!isMeaningfulReview(candidate)) continue

    if (mergedWarnings.has(warningId)) {
      reviews[warningId] = candidate
    } else {
      const title = titlesA.get(warningId)?.title ?? titlesB.get(warningId)?.title ?? warningId
      if (aChanged && isMeaningfulReview(reviewA)) orphanReviews.push({ warningId, warningTitle: title, side: 'a', review: clone(reviewA) })
      if (bChanged && isMeaningfulReview(reviewB) && !deepEqual(reviewA, reviewB)) orphanReviews.push({ warningId, warningTitle: title, side: 'b', review: clone(reviewB) })
      if (!aChanged && !bChanged && isMeaningfulReview(baseReview)) orphanReviews.push({ warningId, warningTitle: title, side: 'a', review: clone(baseReview) })
    }
  }

  return { reviews, orphanReviews }
}

function mergeReplies(base: WarningReview | undefined, a: WarningReview | undefined, b: WarningReview | undefined) {
  const seen = new Map<string, WarningReview['replies'][number]>()
  for (const reply of [...(base?.replies ?? []), ...(a?.replies ?? []), ...(b?.replies ?? [])]) {
    const existing = seen.get(reply.id)
    if (!existing || existing.createdAt < reply.createdAt) seen.set(reply.id, reply)
  }
  return [...seen.values()].sort((x, y) => x.createdAt.localeCompare(y.createdAt))
}

function latestUpdated(...reviews: Array<WarningReview | undefined>): string | undefined {
  const candidates = reviews.flatMap((review) => [review?.updatedAt, ...(review?.replies ?? []).map((reply) => reply.createdAt)]).filter(Boolean) as string[]
  return candidates.sort().at(-1)
}
