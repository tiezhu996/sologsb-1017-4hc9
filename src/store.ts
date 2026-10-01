import { useCallback, useEffect, useRef, useState } from 'react'
import { sampleScript } from './sample'
import { mergeScripts, migrateReviews } from './merge'
import type { Character, ContinuityState, DraftSnapshot, DiffItem, Prop, Reply, Scene, Script, Version, Wardrobe, WarningItem, WarningReview, WorkspaceInfo, WorkspaceRole, WorkspaceSummary, MergeSide, MergeSession } from './types'

const STORAGE_KEY = 'sologsb-1017-continuity-v1'
const WORKSPACE_PREFIX = `${STORAGE_KEY}:workspace:`
const TAB_WORKSPACE_KEY = 'sologsb-1017-workspace'
const clone = <T,>(value: T): T => structuredClone(value)
const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

function workspaceStorageKey(workspaceId: string) {
  return `${WORKSPACE_PREFIX}${workspaceId}`
}

function getInitialWorkspaceId(): string {
  const params = new URLSearchParams(window.location.search)
  const fromUrl = params.get('workspace')
  if (fromUrl) {
    sessionStorage.setItem(TAB_WORKSPACE_KEY, fromUrl)
    return fromUrl
  }
  const fromSession = sessionStorage.getItem(TAB_WORKSPACE_KEY)
  if (fromSession) return fromSession
  const generated = `production-${Date.now().toString(36)}`
  sessionStorage.setItem(TAB_WORKSPACE_KEY, generated)
  return generated
}

function emptyWorkspace(idValue: string, role: WorkspaceRole, name: string, state?: Partial<ContinuityState>): ContinuityState {
  return {
    script: clone(sampleScript),
    reviews: {},
    versions: [],
    updatedAt: new Date().toISOString(),
    activeMerge: null,
    lastMerge: null,
    ...state,
    workspace: {
      ...state?.workspace,
      id: idValue,
      name: state?.workspace?.name ?? name,
      role,
      startedAt: state?.workspace?.startedAt ?? new Date().toISOString()
    }
  }
}

function normalizeState(value: Partial<ContinuityState> | null | undefined, workspaceId: string, role: WorkspaceRole, name: string): ContinuityState {
  const workspace: WorkspaceInfo = {
    ...value?.workspace,
    id: workspaceId,
    name: value?.workspace?.name ?? name,
    role,
    startedAt: value?.workspace?.startedAt ?? new Date().toISOString()
  }
  return {
    script: value?.script ?? clone(sampleScript),
    reviews: value?.reviews ?? {},
    versions: Array.isArray(value?.versions) ? value.versions : [],
    updatedAt: value?.updatedAt ?? new Date().toISOString(),
    activeMerge: value?.activeMerge ?? null,
    lastMerge: value?.lastMerge ?? null,
    workspace
  }
}

function persistWorkspace(state: ContinuityState) {
  try {
    localStorage.setItem(workspaceStorageKey(state.workspace.id), JSON.stringify(state))
  } catch {
    // Storage may be unavailable in private modes; the in-memory draft still works for this session.
  }
}

function readWorkspace(workspaceId: string): ContinuityState | null {
  try {
    const raw = localStorage.getItem(workspaceStorageKey(workspaceId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ContinuityState>
    const role: WorkspaceRole = parsed.workspace?.role ?? 'production'
    return normalizeState(parsed, workspaceId, role, parsed.workspace?.name ?? (role === 'review' ? '审阅与回复工作稿' : '场景道具工作稿'))
  } catch {
    return null
  }
}

function initialState(workspaceId: string): ContinuityState {
  const existing = readWorkspace(workspaceId)
  if (existing?.script?.scenes?.length) return existing

  try {
    const legacyRaw = localStorage.getItem(STORAGE_KEY)
    if (legacyRaw) {
      const parsed = JSON.parse(legacyRaw) as Partial<ContinuityState>
      if (parsed.script?.scenes?.length) {
        const state = normalizeState(parsed, workspaceId, 'production', '场景道具工作稿')
        persistWorkspace(state)
        return state
      }
    }
  } catch {
    // Ignore an invalid legacy draft and restore the bundled example.
  }
  const role: WorkspaceRole = new URLSearchParams(window.location.search).get('role') === 'review' ? 'review' : 'production'
  const state = emptyWorkspace(workspaceId, role, role === 'review' ? '审阅与回复工作稿' : '场景道具工作稿')
  persistWorkspace(state)
  return state
}

export function listWorkspaces(): WorkspaceSummary[] {
  const result: WorkspaceSummary[] = []
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (!key?.startsWith(WORKSPACE_PREFIX)) continue
    const workspaceId = key.slice(WORKSPACE_PREFIX.length)
    const state = readWorkspace(workspaceId)
    if (!state?.workspace) continue
    result.push({ ...state.workspace, updatedAt: state.updatedAt })
  }
  return result.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

export function workspaceUrl(workspaceId: string, role: WorkspaceRole) {
  const url = new URL(window.location.href)
  url.searchParams.set('workspace', workspaceId)
  url.searchParams.set('role', role)
  return url.toString()
}

export function deriveWarnings(script: Script): WarningItem[] {
  const warnings: WarningItem[] = []
  const sceneIndex = (sceneId: string) => script.scenes.findIndex((scene) => scene.id === sceneId)
  const charactersSeen = new Set<string>()
  const propsSeen = new Set<string>()

  script.scenes.forEach((scene, index) => {
    scene.characterIds.forEach((characterId) => {
      const character = script.characters.find((item) => item.id === characterId)
      if (!character) return
      const introducedAt = sceneIndex(character.introducedSceneId)
      if (index > 0 && !charactersSeen.has(characterId) && introducedAt >= index) {
        warnings.push({
          id: `character-${scene.id}-${characterId}`,
          type: 'character',
          severity: index > 1 ? 'error' : 'warning',
          sceneId: scene.id,
          title: `${character.name}突然出现`,
          detail: `角色在场景 ${scene.number} 首次出现，但前序场景没有建立其身份、关系或到场铺垫。`,
          suggestion: `在更早场景补充提及、声音或到场动作，并把“首次建立”场景改为相应场次。`
        })
      }
      charactersSeen.add(characterId)
    })

    scene.propIds.forEach((propId) => {
      const prop = script.props.find((item) => item.id === propId)
      if (!prop) return
      const introducedAt = sceneIndex(prop.introducedSceneId)
      if (!propsSeen.has(propId) && introducedAt > index) {
        warnings.push({
          id: `prop-${scene.id}-${propId}`,
          type: 'prop',
          severity: 'error',
          sceneId: scene.id,
          title: `${prop.name}尚未提前建立`,
          detail: `道具在场景 ${scene.number} 已出现，但首次建立被标记在场景 ${script.scenes[introducedAt]?.number ?? '未知'}。`,
          suggestion: '调整首次建立场景，或在当前场景加入来源、交接动作与持有人反应。'
        })
      }
      propsSeen.add(propId)
    })

    Object.entries(scene.costumes).forEach(([characterId, wardrobeId]) => {
      const wardrobe = script.wardrobes.find((item) => item.id === wardrobeId)
      const character = script.characters.find((item) => item.id === characterId)
      if (!wardrobe || !character) return
      if (!wardrobe.timePeriods.includes(scene.dayNight)) {
        warnings.push({
          id: `wardrobe-${scene.id}-${characterId}-${wardrobeId}`,
          type: 'wardrobe',
          severity: 'warning',
          sceneId: scene.id,
          title: `${character.name}服装与时间冲突`,
          detail: `“${wardrobe.name}”只配置用于 ${wardrobe.timePeriods.join('、')}，本场标记为“${scene.dayNight}”。`,
          suggestion: '确认是否跨越时间连续拍摄；如需延续服装，请把当前时段加入服装适用范围。'
        })
      }
    })

    if (index > 0 && script.scenes[index - 1].storyTime && scene.storyTime) {
      const previous = script.scenes[index - 1]
      const previousDay = previous.storyTime.match(/第\s*(\d+)\s*天/)?.[1]
      const currentDay = scene.storyTime.match(/第\s*(\d+)\s*天/)?.[1]
      if (previousDay && currentDay && Number(currentDay) < Number(previousDay)) {
        warnings.push({
          id: `timeline-${scene.id}`,
          type: 'timeline',
          severity: 'error',
          sceneId: scene.id,
          title: '时间线出现倒退',
          detail: `上一场为第 ${previousDay} 天，本场却标记为第 ${currentDay} 天，可能造成观看顺序混乱。`,
          suggestion: '调整故事时间，或明确使用倒叙并在场次摘要中标注时间跳转。'
        })
      }
    }
  })
  return warnings
}

export function diffScript(base: Script, current: Script): DiffItem[] {
  const fields: Array<{ key: keyof Scene; label: string }> = [
    { key: 'slug', label: '场名' },
    { key: 'synopsis', label: '摘要' },
    { key: 'intExt', label: '内外景' },
    { key: 'location', label: '地点' },
    { key: 'dayNight', label: '日夜' },
    { key: 'storyTime', label: '故事时间' },
    { key: 'pageLength', label: '页数' },
    { key: 'revision', label: '修订色' },
    { key: 'status', label: '状态' },
    { key: 'reason', label: '修改理由' }
  ]
  const result: DiffItem[] = []
  const sceneKey = (scene: Scene) => `${scene.number}|${scene.slug}`
  const baseByKey = new Map(base.scenes.map((scene) => [sceneKey(scene), scene]))
  current.scenes.forEach((scene) => {
    const previous = baseByKey.get(sceneKey(scene)) ?? base.scenes.find((item) => item.id === scene.id)
    if (!previous) {
      result.push({ id: `new-${scene.id}`, sceneNumber: scene.number, field: '场次', before: '不存在', after: `${scene.intExt}. ${scene.location} — ${scene.dayNight}` })
      return
    }
    fields.forEach(({ key, label }) => {
      const before = String(previous[key] ?? '')
      const after = String(scene[key] ?? '')
      if (before !== after) result.push({ id: `${scene.id}-${String(key)}`, sceneNumber: scene.number, field: label, before, after })
    })
  })
  base.scenes.forEach((scene) => {
    if (!current.scenes.some((item) => item.id === scene.id || sceneKey(item) === sceneKey(scene))) {
      result.push({ id: `deleted-${scene.id}`, sceneNumber: scene.number, field: '场次', before: `${scene.intExt}. ${scene.location} — ${scene.dayNight}`, after: '已删除' })
    }
  })
  return result
}

const currentWorkspaceId = getInitialWorkspaceId()

export function useContinuityStore() {
  const [state, setState] = useState<ContinuityState>(() => initialState(currentWorkspaceId))
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving'>('saved')
  const undoRef = useRef<ContinuityState[]>([])
  const redoRef = useRef<ContinuityState[]>([])
  const saveTimer = useRef<number | undefined>(undefined)
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    setSaveStatus('saving')
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      persistWorkspace(state)
      setSaveStatus('saved')
    }, 80)
    return () => window.clearTimeout(saveTimer.current)
  }, [state])

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== workspaceStorageKey(currentWorkspaceId)) return
      const next = readWorkspace(currentWorkspaceId)
      if (next) setState(next)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const commit = useCallback((updater: (previous: ContinuityState) => ContinuityState) => {
    setState((previous) => {
      const next = { ...updater(previous), updatedAt: new Date().toISOString() }
      if (JSON.stringify(next) === JSON.stringify(previous)) return previous
      undoRef.current.push(clone(previous))
      if (undoRef.current.length > 100) undoRef.current.shift()
      redoRef.current = []
      persistWorkspace(next)
      return next
    })
  }, [])

  const mutate = useCallback((mutator: (script: Script) => void) => {
    commit((previous) => {
      const next = clone(previous)
      mutator(next.script)
      return next
    })
  }, [commit])

  const undo = useCallback(() => {
    setState((previous) => {
      const target = undoRef.current.pop()
      if (!target) return previous
      redoRef.current.push(clone(previous))
      persistWorkspace(target)
      return { ...target, updatedAt: new Date().toISOString() }
    })
  }, [])

  const redo = useCallback(() => {
    setState((previous) => {
      const target = redoRef.current.pop()
      if (!target) return previous
      undoRef.current.push(clone(previous))
      persistWorkspace(target)
      return { ...target, updatedAt: new Date().toISOString() }
    })
  }, [])

  const updateScriptField = useCallback((field: 'title' | 'writer' | 'draft', value: string) => {
    mutate((script) => { script[field] = value })
  }, [mutate])

  const updateScene = useCallback((sceneId: string, field: keyof Scene, value: Scene[keyof Scene]) => {
    mutate((script) => {
      const scene = script.scenes.find((item) => item.id === sceneId)
      if (scene) (scene as unknown as Record<string, unknown>)[field] = value
    })
  }, [mutate])

  const toggleSceneRelation = useCallback((sceneId: string, field: 'characterIds' | 'propIds', itemId: string) => {
    mutate((script) => {
      const scene = script.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      const values = scene[field]
      scene[field] = values.includes(itemId) ? values.filter((value) => value !== itemId) : [...values, itemId]
    })
  }, [mutate])

  const setCostume = useCallback((sceneId: string, characterId: string, wardrobeId: string) => {
    mutate((script) => {
      const scene = script.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      if (!wardrobeId) delete scene.costumes[characterId]
      else scene.costumes[characterId] = wardrobeId
    })
  }, [mutate])

  const moveScene = useCallback((sceneId: string, direction: -1 | 1) => {
    mutate((script) => {
      const index = script.scenes.findIndex((scene) => scene.id === sceneId)
      const target = index + direction
      if (index < 0 || target < 0 || target >= script.scenes.length) return
      const [scene] = script.scenes.splice(index, 1)
      script.scenes.splice(target, 0, scene)
    })
  }, [mutate])

  const addScene = useCallback(() => {
    const sceneId = id('scene')
    mutate((script) => {
      const number = String(script.scenes.length + 1)
      script.scenes.push({
        id: sceneId, number, slug: '未命名场景', synopsis: '', intExt: 'INT', location: '待填写', dayNight: '白天', storyTime: `第 1 天`, pageLength: 1,
        characterIds: [], propIds: [], costumes: {}, revision: 'white', status: 'draft', reason: ''
      })
    })
    return sceneId
  }, [mutate])

  const deleteScene = useCallback((sceneId: string) => {
    if (state.script.scenes.length <= 1) return
    mutate((script) => { script.scenes = script.scenes.filter((scene) => scene.id !== sceneId) })
  }, [mutate, state.script.scenes.length])

  const addCharacter = useCallback(() => {
    mutate((script) => {
      script.characters.push({ id: id('char'), name: '新角色', actor: '待定', introducedSceneId: script.scenes[0]?.id ?? '', note: '' })
    })
  }, [mutate])

  const updateCharacter = useCallback((characterId: string, field: keyof Character, value: string) => {
    mutate((script) => {
      const item = script.characters.find((character) => character.id === characterId)
      if (item) item[field] = value
    })
  }, [mutate])

  const addProp = useCallback(() => {
    mutate((script) => {
      script.props.push({ id: id('prop'), name: '新道具', introducedSceneId: script.scenes[0]?.id ?? '', ownerId: script.characters[0]?.id ?? '', note: '' })
    })
  }, [mutate])

  const updateProp = useCallback((propId: string, field: keyof Prop, value: string) => {
    mutate((script) => {
      const item = script.props.find((prop) => prop.id === propId)
      if (item) item[field] = value
    })
  }, [mutate])

  const addWardrobe = useCallback(() => {
    mutate((script) => {
      script.wardrobes.push({ id: id('ward'), characterId: script.characters[0]?.id ?? '', name: '新服装', timePeriods: ['白天'], note: '' })
    })
  }, [mutate])

  const updateWardrobe = useCallback((wardrobeId: string, field: keyof Wardrobe, value: string | string[]) => {
    mutate((script) => {
      const item = script.wardrobes.find((wardrobe) => wardrobe.id === wardrobeId)
      if (item) {
        if (field === 'timePeriods') item.timePeriods = value as string[]
        else item[field] = value as never
      }
    })
  }, [mutate])

  const setReviewStatus = useCallback((warningId: string, status: WarningReview['status']) => {
    commit((previous) => ({
      ...previous,
      reviews: {
        ...previous.reviews,
        [warningId]: { ...(previous.reviews[warningId] ?? { replies: [] }), status }
      }
    }))
  }, [commit])

  const addReply = useCallback((warningId: string, author: string, text: string) => {
    if (!text.trim()) return
    const reply: Reply = { id: id('reply'), author, text: text.trim(), createdAt: new Date().toISOString() }
    commit((previous) => ({
      ...previous,
      reviews: {
        ...previous.reviews,
        [warningId]: {
          status: previous.reviews[warningId]?.status ?? 'pending',
          replies: [...(previous.reviews[warningId]?.replies ?? []), reply]
        }
      }
    }))
  }, [commit])

  const createVersion = useCallback((name: string) => {
    const version: Version = {
      id: id('version'),
      name: name.trim() || `版本 ${stateRef.current.versions.length + 1}`,
      createdAt: new Date().toISOString(),
      script: clone(stateRef.current.script),
      reviews: clone(stateRef.current.reviews)
    }
    commit((previous) => ({ ...previous, versions: [version, ...previous.versions] }))
    return version
  }, [commit])

  const writeBothWorkspaces = useCallback((production: ContinuityState, review: ContinuityState) => {
    persistWorkspace(production)
    persistWorkspace(review)
    setState((previous) => previous.workspace.role === 'review' ? { ...review, updatedAt: new Date().toISOString() } : { ...production, updatedAt: new Date().toISOString() })
  }, [])

  const startCollaboration = useCallback(() => {
    const current = clone(stateRef.current)
    const role: WorkspaceRole = current.workspace.role
    const isProduction = role === 'production'

    if (current.workspace.partnerId) {
      const partner = readWorkspace(current.workspace.partnerId)
      if (partner) {
        window.open(workspaceUrl(partner.workspace.id, partner.workspace.role), '_blank', 'noopener,noreferrer')
        return { productionId: isProduction ? current.workspace.id : partner.workspace.id, reviewId: isProduction ? partner.workspace.id : current.workspace.id }
      }
    }

    const now = new Date().toISOString()
    let productionState: ContinuityState
    let reviewState: ContinuityState
    let productionId: string
    let reviewId: string
    const baseVersion: Version = {
      id: id('version'),
      name: `双人分工基线 · ${new Date().toLocaleString('zh-CN')}`,
      createdAt: now,
      script: clone(current.script),
      reviews: clone(current.reviews)
    }

    if (isProduction) {
      productionId = current.workspace.id
      reviewId = `review-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      productionState = {
        ...current,
        versions: [baseVersion, ...current.versions],
        activeMerge: null,
        lastMerge: null,
        workspace: { ...current.workspace, role: 'production', name: '场景道具工作稿', partnerId: reviewId, baseVersionId: baseVersion.id }
      }
      reviewState = emptyWorkspace(reviewId, 'review', '审阅与回复工作稿', {
        script: clone(current.script),
        reviews: clone(current.reviews),
        versions: [clone(baseVersion)],
        workspace: { id: reviewId, name: '审阅与回复工作稿', role: 'review', partnerId: productionId, baseVersionId: baseVersion.id, startedAt: now }
      })
    } else {
      reviewId = current.workspace.id
      productionId = `production-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      reviewState = {
        ...current,
        versions: [baseVersion, ...current.versions],
        activeMerge: null,
        lastMerge: null,
        workspace: { ...current.workspace, role: 'review', name: '审阅与回复工作稿', partnerId: productionId, baseVersionId: baseVersion.id }
      }
      productionState = emptyWorkspace(productionId, 'production', '场景道具工作稿', {
        script: clone(current.script),
        reviews: clone(current.reviews),
        versions: [clone(baseVersion)],
        workspace: { id: productionId, name: '场景道具工作稿', role: 'production', partnerId: reviewId, baseVersionId: baseVersion.id, startedAt: now }
      })
    }

    const newWorkspaceId = isProduction ? reviewId : productionId
    const newWorkspaceRole: WorkspaceRole = isProduction ? 'review' : 'production'
    writeBothWorkspaces(productionState, reviewState)
    window.open(workspaceUrl(newWorkspaceId, newWorkspaceRole), '_blank', 'noopener,noreferrer')
    return { productionId, reviewId }
  }, [writeBothWorkspaces])

  const getMergePair = useCallback(() => {
    const current = stateRef.current
    if (!current.workspace.partnerId || !current.workspace.baseVersionId) return null
    const partner = readWorkspace(current.workspace.partnerId)
    if (!partner?.workspace) return null
    const baseVersion = current.versions.find((version) => version.id === current.workspace.baseVersionId)
    if (!baseVersion) return null
    const production = current.workspace.role === 'production' ? current : partner
    const review = current.workspace.role === 'review' ? current : partner
    return { current, partner, baseVersion, production, review }
  }, [])

  const startMerge = useCallback((): { ok: boolean; message?: string } => {
    const pair = getMergePair()
    if (!pair) return { ok: false, message: '请先开启双人分工，并确认两个工作稿仍共享同一基线。' }
    const { baseVersion, production, review } = pair
    if (stateRef.current.activeMerge) return { ok: true }

    const merged = mergeScripts(baseVersion.script, production.script, review.script)
    const preMergeVersion: Version = {
      id: id('version'),
      name: `合并前完整稿 · ${new Date().toLocaleString('zh-CN')}`,
      createdAt: new Date().toISOString(),
      script: clone(baseVersion.script),
      reviews: clone(baseVersion.reviews ?? {}),
      mergeBaseVersionId: baseVersion.id,
      mergeSnapshot: {
        production: { script: clone(production.script), reviews: clone(production.reviews) },
        review: { script: clone(review.script), reviews: clone(review.reviews) }
      }
    }
    const session: MergeSession = {
      id: id('merge'),
      name: `双人工作稿合并 · ${new Date().toLocaleString('zh-CN')}`,
      startedAt: new Date().toISOString(),
      preMergeVersionId: preMergeVersion.id,
      baseVersionId: baseVersion.id,
      productionWorkspaceId: production.workspace.id,
      productionWorkspaceName: production.workspace.name,
      reviewWorkspaceId: review.workspace.id,
      reviewWorkspaceName: review.workspace.name,
      productionDraft: { script: clone(production.script), reviews: clone(production.reviews) },
      reviewDraft: { script: clone(review.script), reviews: clone(review.reviews) },
      mergedScript: merged.script,
      conflicts: merged.conflicts,
      autoChanges: merged.autoChanges
    }

    const nextProduction: ContinuityState = {
      ...production,
      versions: [preMergeVersion, ...production.versions],
      activeMerge: session
    }
    const nextReview: ContinuityState = {
      ...review,
      versions: [clone(preMergeVersion), ...review.versions],
      activeMerge: clone(session)
    }
    writeBothWorkspaces(nextProduction, nextReview)
    return { ok: true }
  }, [getMergePair, writeBothWorkspaces])

  const rebuildMerge = useCallback((previous: ContinuityState, session: MergeSession, resolutions: Record<string, MergeSide>) => {
    const baseVersion = previous.versions.find((version) => version.id === session.baseVersionId)
    if (!baseVersion) return session
    const merged = mergeScripts(baseVersion.script, session.productionDraft.script, session.reviewDraft.script, resolutions)
    return { ...session, mergedScript: merged.script, conflicts: merged.conflicts, autoChanges: merged.autoChanges }
  }, [])

  const resolveMergeConflict = useCallback((conflictId: string, side: MergeSide) => {
    const current = stateRef.current
    if (!current.activeMerge) return
    const session = clone(current.activeMerge)
    const resolutions: Record<string, MergeSide> = {}
    session.conflicts.forEach((conflict) => {
      if (conflict.resolution) resolutions[conflict.id] = conflict.resolution
    })
    resolutions[conflictId] = side
    const productionId = session.productionWorkspaceId
    const reviewId = session.reviewWorkspaceId
    const productionRaw = current.workspace.id === productionId ? current : readWorkspace(productionId)
    const reviewRaw = current.workspace.id === reviewId ? current : readWorkspace(reviewId)
    if (!productionRaw || !reviewRaw) return

    const productionSession = rebuildMerge(productionRaw, clone(session), resolutions)
    const reviewSession = rebuildMerge(reviewRaw, clone(session), resolutions)
    writeBothWorkspaces(
      { ...productionRaw, activeMerge: productionSession },
      { ...reviewRaw, activeMerge: reviewSession }
    )
  }, [rebuildMerge, writeBothWorkspaces])

  const cancelMerge = useCallback(() => {
    const current = stateRef.current
    if (!current.activeMerge) return
    const session = current.activeMerge
    const productionRaw = current.workspace.id === session.productionWorkspaceId ? current : readWorkspace(session.productionWorkspaceId)
    const reviewRaw = current.workspace.id === session.reviewWorkspaceId ? current : readWorkspace(session.reviewWorkspaceId)
    if (!productionRaw || !reviewRaw) return
    writeBothWorkspaces({ ...productionRaw, activeMerge: null }, { ...reviewRaw, activeMerge: null })
  }, [writeBothWorkspaces])

  const completeMerge = useCallback((): { ok: boolean; message?: string } => {
    const current = stateRef.current
    const session = current.activeMerge
    if (!session) return { ok: false, message: '没有进行中的合并。' }
    if (session.conflicts.some((conflict) => !conflict.resolution)) return { ok: false, message: '仍有同一字段的两版内容需要选定。' }

    const preMergeVersionId = session.preMergeVersionId
    const mergedWarnings = deriveWarnings(session.mergedScript)
    const migration = migrateReviews({
      mergedScript: session.mergedScript,
      mergedWarnings,
      production: { ...session.productionDraft, warnings: deriveWarnings(session.productionDraft.script) },
      review: { ...session.reviewDraft, warnings: deriveWarnings(session.reviewDraft.script) }
    })
    const now = new Date().toISOString()
    const postMergeVersion: Version = {
      id: id('version'),
      name: `合并后基线 · ${new Date().toLocaleString('zh-CN')}`,
      createdAt: now,
      script: clone(session.mergedScript),
      reviews: clone(migration.migratedReviews)
    }
    const report = {
      id: id('merge-report'),
      completedAt: now,
      preMergeVersionId,
      autoMergedCount: session.autoChanges.length,
      conflictCount: session.conflicts.length,
      migratedReviews: migration.migratedReviews,
      orphanReviews: migration.orphanReviews
    }

    const productionRaw = current.workspace.id === session.productionWorkspaceId ? current : readWorkspace(session.productionWorkspaceId)
    const reviewRaw = current.workspace.id === session.reviewWorkspaceId ? current : readWorkspace(session.reviewWorkspaceId)
    if (!productionRaw || !reviewRaw) return { ok: false, message: '找不到另一个工作稿，请不要关闭对应浏览器存储。' }

    const production: ContinuityState = {
      ...productionRaw,
      script: clone(session.mergedScript),
      reviews: clone(migration.migratedReviews),
      versions: [postMergeVersion, ...productionRaw.versions],
      activeMerge: null,
      lastMerge: clone(report),
      workspace: { ...productionRaw.workspace, baseVersionId: postMergeVersion.id }
    }
    const review: ContinuityState = {
      ...reviewRaw,
      script: clone(session.mergedScript),
      reviews: clone(migration.migratedReviews),
      versions: [clone(postMergeVersion), ...reviewRaw.versions],
      activeMerge: null,
      lastMerge: clone(report),
      workspace: { ...reviewRaw.workspace, baseVersionId: postMergeVersion.id }
    }
    writeBothWorkspaces(production, review)
    return { ok: true }
  }, [writeBothWorkspaces])

  const restoreMergeVersion = useCallback((version: Version) => {
    if (!version.mergeSnapshot) return false
    const current = stateRef.current
    const productionId = current.activeMerge?.productionWorkspaceId ?? (current.workspace.role === 'production' ? current.workspace.id : current.workspace.partnerId)
    const reviewId = current.activeMerge?.reviewWorkspaceId ?? (current.workspace.role === 'review' ? current.workspace.id : current.workspace.partnerId)
    if (!productionId || !reviewId) return false
    const productionOld = readWorkspace(productionId)
    const reviewOld = readWorkspace(reviewId)
    if (!productionOld || !reviewOld) return false
    const snapshot = version.mergeSnapshot
    const production: ContinuityState = {
      ...productionOld,
      script: clone(snapshot.production.script),
      reviews: clone(snapshot.production.reviews),
      activeMerge: null,
      lastMerge: null,
      workspace: { ...productionOld.workspace, baseVersionId: version.mergeBaseVersionId ?? productionOld.workspace.baseVersionId }
    }
    const review: ContinuityState = {
      ...reviewOld,
      script: clone(snapshot.review.script),
      reviews: clone(snapshot.review.reviews),
      activeMerge: null,
      lastMerge: null,
      workspace: { ...reviewOld.workspace, baseVersionId: version.mergeBaseVersionId ?? reviewOld.workspace.baseVersionId }
    }
    writeBothWorkspaces(production, review)
    return true
  }, [writeBothWorkspaces])

  const restoreVersion = useCallback((versionId: string) => {
    const version = stateRef.current.versions.find((item) => item.id === versionId)
    if (!version) return
    if (version.mergeSnapshot) {
      restoreMergeVersion(version)
      return
    }
    commit((previous) => ({
      ...previous,
      script: clone(version.script),
      reviews: clone(version.reviews ?? {})
    }))
  }, [commit, restoreMergeVersion])

  const undoLastMerge = useCallback(() => {
    const report = stateRef.current.lastMerge
    if (!report?.preMergeVersionId) return false
    const version = stateRef.current.versions.find((item) => item.id === report.preMergeVersionId)
    if (!version?.mergeSnapshot) return false
    return restoreMergeVersion(version)
  }, [restoreMergeVersion])

  const reset = useCallback(() => {
    commit((previous) => ({ ...previous, script: clone(sampleScript), reviews: {}, activeMerge: null, lastMerge: null }))
  }, [commit])

  return {
    state,
    saveStatus,
    warnings: deriveWarnings(state.script),
    updateScriptField,
    updateScene,
    toggleSceneRelation,
    setCostume,
    moveScene,
    addScene,
    deleteScene,
    addCharacter,
    updateCharacter,
    addProp,
    updateProp,
    addWardrobe,
    updateWardrobe,
    setReviewStatus,
    addReply,
    createVersion,
    restoreVersion,
    undoLastMerge,
    startCollaboration,
    startMerge,
    resolveMergeConflict,
    cancelMerge,
    completeMerge,
    undo,
    redo,
    reset
  }
}
