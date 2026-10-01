import type {
  Character,
  MergeAutoChange,
  MergeConflict,
  MergeConflictScope,
  MergeSide,
  Prop,
  Scene,
  Script,
  Wardrobe,
  WarningItem,
  WarningReview,
  OrphanReview,
  DraftSnapshot
} from './types'

type Entity = Scene | Character | Prop | Wardrobe
type CollectionKey = 'scenes' | 'characters' | 'props' | 'wardrobes'

interface FieldDefinition<T> {
  key: keyof T & string
  label: string
}

const sceneFields: Array<FieldDefinition<Scene>> = [
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
  { key: 'costumes', label: '服装' },
  { key: 'revision', label: '修订色' },
  { key: 'status', label: '状态' },
  { key: 'reason', label: '修改理由' }
]

const characterFields: Array<FieldDefinition<Character>> = [
  { key: 'name', label: '姓名' },
  { key: 'actor', label: '演员' },
  { key: 'introducedSceneId', label: '首次建立场景' },
  { key: 'note', label: '备注' }
]

const propFields: Array<FieldDefinition<Prop>> = [
  { key: 'name', label: '道具' },
  { key: 'introducedSceneId', label: '首次建立场景' },
  { key: 'ownerId', label: '持有人' },
  { key: 'note', label: '连续性备注' }
]

const wardrobeFields: Array<FieldDefinition<Wardrobe>> = [
  { key: 'characterId', label: '所属角色' },
  { key: 'name', label: '服装' },
  { key: 'timePeriods', label: '适用时段' },
  { key: 'note', label: '备注' }
]

const scriptFields: Array<FieldDefinition<Script>> = [
  { key: 'title', label: '剧名' },
  { key: 'writer', label: '作者' },
  { key: 'draft', label: '稿次' }
]

const stableEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const stableString = (value: unknown) => JSON.stringify(value) ?? ''
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function entityLabel(scope: MergeConflictScope, entity: Entity | undefined): string {
  if (!entity) return '已删除'
  if (scope === 'scene') {
    const scene = entity as Scene
    return `场景 ${scene.number} · ${scene.slug}`
  }
  return (entity as Character | Prop | Wardrobe).name
}

interface FieldMergeContext {
  scope: Exclude<MergeConflictScope, 'script'>
  entityId: string
  entityLabel: string
  field: FieldDefinition<Entity>
  resolutions: Record<string, MergeSide>
}

interface FieldMergeResult {
  value: unknown
  mode: 'none' | 'production' | 'review' | 'both' | 'conflict'
  conflicts: MergeConflict[]
}

function mergeFieldValue(baseValue: unknown, productionValue: unknown, reviewValue: unknown, context: FieldMergeContext): FieldMergeResult {
  const { scope, entityId, entityLabel, field, resolutions } = context
  const productionChanged = !stableEqual(baseValue, productionValue)
  const reviewChanged = !stableEqual(baseValue, reviewValue)
  const pushFieldConflict = (valueProduction: unknown, valueReview: unknown, conflictId: string, conflictField: string, conflictLabel: string): MergeConflict => ({
    id: conflictId,
    kind: 'field',
    scope,
    entityId,
    entityLabel,
    field: conflictField,
    fieldLabel: conflictLabel,
    base: clone(baseValue),
    production: clone(valueProduction),
    review: clone(valueReview),
    resolution: resolutions[conflictId] ?? null
  })

  if (!productionChanged && reviewChanged) return { value: clone(reviewValue), mode: 'review', conflicts: [] }
  if (productionChanged && !reviewChanged) return { value: clone(productionValue), mode: 'production', conflicts: [] }
  if (!productionChanged && !reviewChanged) return { value: clone(baseValue), mode: 'none', conflicts: [] }
  if (stableEqual(productionValue, reviewValue)) return { value: clone(productionValue), mode: 'both', conflicts: [] }

  if (Array.isArray(baseValue) && Array.isArray(productionValue) && Array.isArray(reviewValue) && [...baseValue, ...productionValue, ...reviewValue].every((item) => ['string', 'number'].includes(typeof item))) {
    const baseSet = new Set(baseValue as Array<string | number>)
    const productionSet = new Set(productionValue as Array<string | number>)
    const reviewSet = new Set(reviewValue as Array<string | number>)
    const productionAdded = [...productionSet].filter((item) => !baseSet.has(item))
    const reviewAdded = [...reviewSet].filter((item) => !baseSet.has(item))
    const productionRemoved = [...baseSet].filter((item) => !productionSet.has(item))
    const reviewRemoved = [...baseSet].filter((item) => !reviewSet.has(item))
    const oppositeChanges = productionAdded.some((item) => reviewRemoved.includes(item)) || reviewAdded.some((item) => productionRemoved.includes(item))
    if (!oppositeChanges) {
      const merged = [...(productionValue as Array<string | number>)]
      reviewValue.forEach((item) => { if (!merged.includes(item)) merged.push(item) })
      return { value: merged.filter((item) => !productionRemoved.includes(item) || !reviewRemoved.includes(item)), mode: 'both', conflicts: [] }
    }
  }

  if (baseValue && productionValue && reviewValue && [baseValue, productionValue, reviewValue].every((item) => typeof item === 'object' && !Array.isArray(item))) {
    const baseObject = baseValue as Record<string, unknown>
    const productionObject = productionValue as Record<string, unknown>
    const reviewObject = reviewValue as Record<string, unknown>
    const mergedObject: Record<string, unknown> = {}
    const conflicts: MergeConflict[] = []
    let hasConflict = false

    Array.from(new Set([...Object.keys(baseObject), ...Object.keys(productionObject), ...Object.keys(reviewObject)])).forEach((key) => {
      const baseItem = baseObject[key]
      const productionItem = productionObject[key]
      const reviewItem = reviewObject[key]
      const itemProductionChanged = !stableEqual(baseItem, productionItem)
      const itemReviewChanged = !stableEqual(baseItem, reviewItem)
      const conflictId = `${scope}-${entityId}-${field.key}.${key}`

      if (!itemProductionChanged && itemReviewChanged) mergedObject[key] = clone(reviewItem)
      else if (itemProductionChanged && !itemReviewChanged) mergedObject[key] = clone(productionItem)
      else if (itemProductionChanged && itemReviewChanged && !stableEqual(productionItem, reviewItem)) {
        hasConflict = true
        conflicts.push(pushFieldConflict(productionItem, reviewItem, conflictId, `${field.key}.${key}`, `${field.label} · ${key}`))
        mergedObject[key] = clone((resolutions[conflictId] ?? 'production') === 'production' ? productionItem : reviewItem)
      } else mergedObject[key] = clone(productionItem)
    })
    return { value: mergedObject, mode: hasConflict ? 'conflict' : 'both', conflicts }
  }

  const conflictId = `${scope}-${entityId}-${field.key}`
  return {
    value: clone((resolutions[conflictId] ?? 'production') === 'production' ? productionValue : reviewValue),
    mode: 'conflict',
    conflicts: [pushFieldConflict(productionValue, reviewValue, conflictId, field.key, field.label)]
  }
}

function makeConflict(
  conflict: Omit<MergeConflict, 'resolution'>,
  resolutions: Record<string, MergeSide>
): MergeConflict {
  return { ...conflict, resolution: resolutions[conflict.id] ?? null }
}

interface CollectionResult {
  entries: Entity[]
  conflicts: MergeConflict[]
  autoChanges: MergeAutoChange[]
}

function mergeCollection(params: {
  scope: Exclude<MergeConflictScope, 'script'>
  collection: CollectionKey
  base: Entity[]
  production: Entity[]
  review: Entity[]
  fields: Array<FieldDefinition<Entity>>
  resolutions: Record<string, MergeSide>
}): CollectionResult {
  const { scope, collection, base, production, review, fields, resolutions } = params
  const byId = (items: Entity[]) => new Map(items.map((item) => [item.id, item]))
  const baseMap = byId(base)
  const productionMap = byId(production)
  const reviewMap = byId(review)
  const selected = new Map<string, Entity | undefined>()
  const conflicts: MergeConflict[] = []
  const autoChanges: MergeAutoChange[] = []
  const scopeLabel = scope === 'scene' ? '场景' : scope === 'character' ? '角色' : scope === 'prop' ? '道具' : '服装'

  Array.from(new Set([...baseMap.keys(), ...productionMap.keys(), ...reviewMap.keys()])).forEach((entityId) => {
    const baseEntity = baseMap.get(entityId)
    const productionEntity = productionMap.get(entityId)
    const reviewEntity = reviewMap.get(entityId)
    const label = entityLabel(scope, productionEntity ?? reviewEntity ?? baseEntity)
    const entityConflictId = `${scope}-${entityId}-entity`

    if (!baseEntity) {
      if (productionEntity && reviewEntity) {
        if (stableEqual(productionEntity, reviewEntity)) {
          selected.set(entityId, clone(productionEntity))
          autoChanges.push({ id: `${entityConflictId}-add`, label: `新增${scopeLabel}`, detail: label, side: 'both' })
        } else {
          fields.forEach((field) => {
            const productionValue = productionEntity[field.key]
            const reviewValue = reviewEntity[field.key]
            if (!stableEqual(productionValue, reviewValue)) {
              conflicts.push(makeConflict({
                id: `${scope}-${entityId}-${field.key}`,
                kind: 'field',
                scope,
                entityId,
                entityLabel: label,
                field: field.key,
                fieldLabel: field.label,
                base: undefined,
                production: productionValue,
                review: reviewValue
              }, resolutions))
            }
          })
          selected.set(entityId, clone((resolutions[entityConflictId] ?? 'production') === 'review' ? reviewEntity : productionEntity))
        }
      } else if (productionEntity || reviewEntity) {
        const side = productionEntity ? 'production' : 'review'
        selected.set(entityId, clone(productionEntity ?? reviewEntity)!)
        autoChanges.push({ id: `${entityConflictId}-add`, label: `新增${scopeLabel}`, detail: label, side })
      }
      return
    }

    if (!productionEntity && !reviewEntity) {
      autoChanges.push({ id: `${entityConflictId}-delete`, label: `删除${scopeLabel}`, detail: label, side: 'both' })
      return
    }

    if (!productionEntity || !reviewEntity) {
      const changedEntity = productionEntity ?? reviewEntity
      const unchangedEntity = productionEntity ? reviewEntity : productionEntity
      const deletedSide: MergeSide = productionEntity ? 'review' : 'production'
      const changedSide: MergeSide = productionEntity ? 'production' : 'review'
      if (unchangedEntity && stableEqual(unchangedEntity, baseEntity)) {
        autoChanges.push({ id: `${entityConflictId}-delete`, label: `删除${scopeLabel}`, detail: label, side: deletedSide })
        return
      }
      conflicts.push(makeConflict({
        id: entityConflictId,
        kind: 'entity',
        scope,
        entityId,
        entityLabel: label,
        field: '__entity__',
        fieldLabel: `${scopeLabel}整体`,
        base: clone(baseEntity),
        production: productionEntity ? clone(productionEntity) : null,
        review: reviewEntity ? clone(reviewEntity) : null
      }, resolutions))
      const resolution = resolutions[entityConflictId] ?? 'production'
      selected.set(entityId, resolution === changedSide ? clone(changedEntity!) : undefined)
      return
    }

    const next: Entity = clone(baseEntity)
    let changed = false
    fields.forEach((field) => {
      const baseValue = baseEntity[field.key]
      const productionValue = productionEntity[field.key]
      const reviewValue = reviewEntity[field.key]
      const result = mergeFieldValue(baseValue, productionValue, reviewValue, {
        scope,
        entityId,
        entityLabel: label,
        field,
        resolutions
      })
      if (result.conflicts.length) {
        conflicts.push(...result.conflicts)
        changed = true
        next[field.key] = clone(result.value) as never
        return
      }
      if (result.mode === 'none') return
      changed = true
      next[field.key] = clone(result.value) as never
      if (result.mode === 'production') autoChanges.push({ id: `${scope}-${entityId}-${field.key}-auto`, label: `${label} / ${field.label}`, detail: '仅场景道具工作稿修改，已自动合入', side: 'production' })
      else if (result.mode === 'review') autoChanges.push({ id: `${scope}-${entityId}-${field.key}-auto`, label: `${label} / ${field.label}`, detail: '仅审阅工作稿修改，已自动合入', side: 'review' })
      else autoChanges.push({ id: `${scope}-${entityId}-${field.key}-auto`, label: `${label} / ${field.label}`, detail: '双方不同修改互不冲突，已自动合入', side: 'both' })
    })
    selected.set(entityId, changed ? next : clone(baseEntity))
  })

  const baseIds = base.map((item) => item.id)
  const productionIds = production.map((item) => item.id)
  const reviewIds = review.map((item) => item.id)
  let orderedIds: string[]
  if (stableEqual(baseIds, productionIds) && stableEqual(baseIds, reviewIds)) orderedIds = baseIds
  else if (stableEqual(baseIds, productionIds)) orderedIds = reviewIds
  else if (stableEqual(baseIds, reviewIds)) orderedIds = productionIds
  else if (stableEqual(productionIds, reviewIds)) orderedIds = productionIds
  else {
    const conflictId = `${scope}-order`
    conflicts.push(makeConflict({
      id: conflictId,
      kind: 'order',
      scope,
      field: '__order__',
      fieldLabel: `${scopeLabel}顺序`,
      base: baseIds,
      production: productionIds,
      review: reviewIds
    }, resolutions))
    orderedIds = (resolutions[conflictId] ?? 'production') === 'production' ? productionIds : reviewIds
    autoChanges.push({ id: `${conflictId}-notice`, label: `${scopeLabel}顺序`, detail: '两稿都调整过顺序，需要人工选择', side: 'both' })
  }

  const entries = orderedIds.map((entityId) => selected.get(entityId)).filter((item): item is Entity => Boolean(item))
  selected.forEach((entity, entityId) => {
    if (entity && !orderedIds.includes(entityId)) entries.push(entity)
  })
  return { entries, conflicts, autoChanges }
}

export function mergeScripts(
  baseScript: Script,
  productionScript: Script,
  reviewScript: Script,
  resolutions: Record<string, MergeSide> = {}
): { script: Script; conflicts: MergeConflict[]; autoChanges: MergeAutoChange[] } {
  const merged: Script = clone(baseScript)
  const conflicts: MergeConflict[] = []
  const autoChanges: MergeAutoChange[] = []

  scriptFields.forEach((field) => {
    const baseValue = baseScript[field.key]
    const productionValue = productionScript[field.key]
    const reviewValue = reviewScript[field.key]
    if (stableEqual(baseValue, productionValue) && !stableEqual(baseValue, reviewValue)) {
      merged[field.key] = reviewValue as never
      autoChanges.push({ id: `script-${field.key}-auto`, label: field.label, detail: '仅审阅工作稿修改，已自动合入', side: 'review' })
    } else if (stableEqual(baseValue, reviewValue) && !stableEqual(baseValue, productionValue)) {
      merged[field.key] = productionValue as never
      autoChanges.push({ id: `script-${field.key}-auto`, label: field.label, detail: '仅场景道具工作稿修改，已自动合入', side: 'production' })
    } else if (!stableEqual(baseValue, productionValue) || !stableEqual(baseValue, reviewValue)) {
      if (stableEqual(productionValue, reviewValue)) {
        merged[field.key] = productionValue as never
        autoChanges.push({ id: `script-${field.key}-auto`, label: field.label, detail: '两稿相同修改，已自动合入', side: 'both' })
      } else {
        conflicts.push(makeConflict({
          id: `script-${field.key}`,
          kind: 'field',
          scope: 'script',
          field: field.key,
          fieldLabel: field.label,
          base: baseValue,
          production: productionValue,
          review: reviewValue
        }, resolutions))
        merged[field.key] = ((resolutions[`script-${field.key}`] ?? 'production') === 'production' ? productionValue : reviewValue) as never
      }
    }
  })

  const collections: Array<{ key: CollectionKey; scope: Exclude<MergeConflictScope, 'script'>; fields: Array<FieldDefinition<Entity>> }> = [
    { key: 'scenes', scope: 'scene', fields: sceneFields as Array<FieldDefinition<Entity>> },
    { key: 'characters', scope: 'character', fields: characterFields as Array<FieldDefinition<Entity>> },
    { key: 'props', scope: 'prop', fields: propFields as Array<FieldDefinition<Entity>> },
    { key: 'wardrobes', scope: 'wardrobe', fields: wardrobeFields as Array<FieldDefinition<Entity>> }
  ]

  collections.forEach(({ key, scope, fields }) => {
    const result = mergeCollection({
      scope,
      collection: key,
      base: baseScript[key] as Entity[],
      production: productionScript[key] as Entity[],
      review: reviewScript[key] as Entity[],
      fields,
      resolutions
    })
    merged[key] = result.entries as never
    conflicts.push(...result.conflicts)
    autoChanges.push(...result.autoChanges)
  })

  return { script: merged, conflicts, autoChanges }
}

export function formatMergeValue(value: unknown): string {
  if (value === null) return '本稿删除'
  if (value === undefined) return '空'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return value || '空'
  if (Array.isArray(value)) return value.length ? value.map((item) => formatMergeValue(item)).join('、') : '空'
  if (typeof value === 'object') return Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key}: ${formatMergeValue(item)}`).join('；') || '空'
  return String(value)
}

interface ReviewMigrationInput {
  mergedScript: Script
  mergedWarnings: WarningItem[]
  production: DraftSnapshot & { warnings: WarningItem[] }
  review: DraftSnapshot & { warnings: WarningItem[] }
}

export function migrateReviews(input: ReviewMigrationInput) {
  const migratedReviews: Record<string, WarningReview> = {}
  const orphanMap = new Map<string, OrphanReview>()

  const addOrphan = (warningId: string, warning: WarningItem | undefined, review: WarningReview, reason: string) => {
    if (!orphanMap.has(warningId)) orphanMap.set(warningId, { warningId, warning, review, reason })
  }

  input.mergedWarnings.forEach((warning) => {
    const productionReview = input.production.reviews[warning.id]
    const reviewReview = input.review.reviews[warning.id]
    const productionWarning = input.production.warnings.find((item) => item.id === warning.id)
    const reviewWarning = input.review.warnings.find((item) => item.id === warning.id)
    const productionMatches = Boolean(productionReview && productionWarning && stableEqual(productionWarning, warning))
    const reviewMatches = Boolean(reviewReview && reviewWarning && stableEqual(reviewWarning, warning))

    if (reviewMatches && reviewReview) migratedReviews[warning.id] = clone(reviewReview)
    else if (productionMatches && productionReview) migratedReviews[warning.id] = clone(productionReview)
  })

  const inspectDraft = (draft: DraftSnapshot & { warnings: WarningItem[] }, sideLabel: string) => {
    Object.entries(draft.reviews).forEach(([warningId, review]) => {
      if (migratedReviews[warningId]) return
      const warning = draft.warnings.find((item) => item.id === warningId)
      const mergedWarning = input.mergedWarnings.find((item) => item.id === warningId)
      const reason = !mergedWarning
        ? `该警告属于${sideLabel}，合并后的对应场景或问题已不存在`
        : warning && !stableEqual(warning, mergedWarning)
          ? `该警告随${sideLabel}的场景内容生成，合并后内容已变化，未自动套用`
          : `该决定属于${sideLabel}，未自动套用到合并稿`
      addOrphan(warningId, warning ?? mergedWarning, clone(review), reason)
    })
  }

  inspectDraft(input.production, '场景道具工作稿')
  inspectDraft(input.review, '审阅工作稿')
  return { migratedReviews, orphanReviews: Array.from(orphanMap.values()) }
}
