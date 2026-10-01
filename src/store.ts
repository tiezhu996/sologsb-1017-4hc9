import { useCallback, useEffect, useRef, useState } from 'react'
import { sampleScript } from './sample'
import { deriveWarnings } from './checks'
import {
  buildMergedReviews,
  buildMergedScript,
  computeMerge,
  deepEqual,
  unresolvedConflicts
} from './merge'
import type {
  Character,
  ContinuityState,
  DiffItem,
  DraftBranch,
  EntityConflict,
  MergeBase,
  MergeSession,
  OrphanReview,
  Peer,
  PeerRole,
  Prop,
  Reply,
  Scene,
  Script,
  Version,
  ConflictSide,
  Wardrobe,
  WarningReview
} from './types'

const STORAGE_KEY = 'sologsb-1017-continuity-v1'
const PEER_ID_KEY = 'sologsb-1017-peer-id'
const META_KEY = 'sologsb-1017-collab-meta'
const PRESENCE_PREFIX = 'sologsb-1017-collab-peer:'
const DRAFT_PREFIX = 'sologsb-1017-collab-draft:'
const MERGE_PREFIX = 'sologsb-1017-collab-merge:'
const PEER_TIMEOUT_MS = 9000

const clone = <T,>(value: T): T => structuredClone(value)
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

interface HistoryEntry {
  script: Script
  reviews: Record<string, WarningReview>
}

interface CollabMeta {
  base: MergeBase | null
  activeMergeId: string | null
  /** 最近完成的合并 id，驱动另一个标签页可靠采用合并稿（避免 storage 事件被批处理而漏采用） */
  completedMergeId: string | null
}

function getPeerId(): string {
  let peerId = sessionStorage.getItem(PEER_ID_KEY)
  if (!peerId) {
    peerId = newId('peer')
    sessionStorage.setItem(PEER_ID_KEY, peerId)
  }
  return peerId
}

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function loadMeta(): CollabMeta {
  const meta = readJSON<Partial<CollabMeta> | null>(META_KEY, null)
  return {
    base: meta?.base ?? null,
    activeMergeId: meta?.activeMergeId ?? null,
    completedMergeId: meta?.completedMergeId ?? null
  }
}

function saveMeta(meta: CollabMeta) {
  localStorage.setItem(META_KEY, JSON.stringify(meta))
}

function writePresence(peer: Peer) {
  localStorage.setItem(PRESENCE_PREFIX + peer.id, JSON.stringify(peer))
}

function listPeers(now = Date.now()): Peer[] {
  const peers: Peer[] = []
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (!key?.startsWith(PRESENCE_PREFIX)) continue
    const peer = readJSON<Peer | null>(key, null)
    if (peer && now - new Date(peer.lastSeenAt).getTime() < PEER_TIMEOUT_MS) peers.push(peer)
  }
  return peers.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))
}

function draftKey(peerId: string) {
  return DRAFT_PREFIX + peerId
}

function mergeKey(mergeId: string) {
  return MERGE_PREFIX + mergeId
}

function readDraft(peerId: string): DraftBranch | null {
  return readJSON<DraftBranch | null>(draftKey(peerId), null)
}

function writeDraft(peerId: string, draft: DraftBranch) {
  localStorage.setItem(draftKey(peerId), JSON.stringify(draft))
}

function readSession(mergeId: string): MergeSession | null {
  return readJSON<MergeSession | null>(mergeKey(mergeId), null)
}

function writeSession(session: MergeSession) {
  localStorage.setItem(mergeKey(session.id), JSON.stringify(session))
}

function initialState(): ContinuityState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as ContinuityState
      if (parsed.script?.scenes?.length) return parsed
    }
  } catch {
    // Ignore an invalid local draft and restore the bundled example.
  }
  return { script: clone(sampleScript), reviews: {}, versions: [], updatedAt: new Date().toISOString() }
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

export interface CollabView {
  peerId: string
  joined: boolean
  role: PeerRole | null
  peers: Peer[]
  canEditScript: boolean
  canReview: boolean
  activeSession: MergeSession | null
  /** 整页关闭后重开、本标签页身份已不是会话参与者时，可重新挂回那场未决合并 */
  recoverableMerge: MergeSession | null
  lastOrphans: OrphanReview[]
}

export function useContinuityStore() {
  const [state, setState] = useState<ContinuityState>(initialState)
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving'>('saved')
  const [meta, setMeta] = useState<CollabMeta>(loadMeta)
  const [peers, setPeers] = useState<Peer[]>(() => listPeers())
  const [activeSession, setActiveSession] = useState<MergeSession | null>(() => {
    const initialMeta = loadMeta()
    return initialMeta.activeMergeId ? readSession(initialMeta.activeMergeId) : null
  })
  const [lastOrphans, setLastOrphans] = useState<OrphanReview[]>([])
  const undoRef = useRef<HistoryEntry[]>([])
  const redoRef = useRef<HistoryEntry[]>([])
  const saveTimer = useRef<number | undefined>(undefined)
  const peerIdRef = useRef(getPeerId())
  const stateRef = useRef(state)
  stateRef.current = state

  const ownPeer = peers.find((peer) => peer.id === peerIdRef.current) ?? null
  const role = ownPeer?.role ?? null
  const joined = !!meta.base && !!role

  // 自动保存：主工作稿始终落 STORAGE_KEY；协作中另写本标签页独占的草稿槽，互不覆盖。
  useEffect(() => {
    setSaveStatus('saving')
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
      const currentMeta = loadMeta()
      const currentPeer = listPeers().find((peer) => peer.id === peerIdRef.current)
      if (currentMeta.base && currentPeer) {
        const draft: DraftBranch = {
          peerId: currentPeer.id,
          role: currentPeer.role,
          label: currentPeer.label,
          script: clone(state.script),
          reviews: clone(state.reviews),
          updatedAt: new Date().toISOString()
        }
        writeDraft(currentPeer.id, draft)
      }
      setSaveStatus('saved')
    }, 160)
    return () => window.clearTimeout(saveTimer.current)
  }, [state])

  // 重开恢复：草稿槽还在但 presence 已过期时，自动恢复在线身份；有待选定合并则继续挂起。
  useEffect(() => {
    const currentMeta = loadMeta()
    if (!currentMeta.base) return
    const ownDraft = readDraft(peerIdRef.current)
    if (ownDraft && !listPeers().some((peer) => peer.id === peerIdRef.current)) {
      const now = new Date().toISOString()
      writePresence({
        id: peerIdRef.current,
        role: ownDraft.role,
        label: ownDraft.label,
        startedAt: now,
        lastSeenAt: now
      })
      setPeers(listPeers())
    }
  }, [])

  // 心跳：每个标签页只写自己的 presence 键，没有跨标签页写冲突；同时兜底落一次草稿，
  // 保证断网恢复发起合并时对方读到的工作稿最多落后一个心跳周期。
  useEffect(() => {
    if (!joined) return
    const beat = () => {
      const current = listPeers().find((peer) => peer.id === peerIdRef.current)
      if (current) {
        const now = new Date().toISOString()
        writePresence({ ...current, lastSeenAt: now })
        writeDraft(current.id, {
          peerId: current.id,
          role: current.role,
          label: current.label,
          script: clone(stateRef.current.script),
          reviews: clone(stateRef.current.reviews),
          updatedAt: now
        })
      }
      setPeers(listPeers())
    }
    beat()
    const timer = window.setInterval(beat, 2500)
    const flushOnHide = () => {
      const current = listPeers().find((peer) => peer.id === peerIdRef.current)
      if (!current) return
      writeDraft(current.id, {
        peerId: current.id,
        role: current.role,
        label: current.label,
        script: clone(stateRef.current.script),
        reviews: clone(stateRef.current.reviews),
        updatedAt: new Date().toISOString()
      })
    }
    window.addEventListener('beforeunload', flushOnHide)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('beforeunload', flushOnHide)
    }
  }, [joined, role])

  // 跨标签页同步：对方心跳、合并会话落盘（含逐字段选定）或合并完成时本页即时感知。
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (!event.key) return
      if (event.key === META_KEY) {
        setMeta(loadMeta())
      } else if (event.key.startsWith(MERGE_PREFIX)) {
        const currentMeta = loadMeta()
        if (currentMeta.activeMergeId && event.key === mergeKey(currentMeta.activeMergeId)) {
          setActiveSession(readSession(currentMeta.activeMergeId))
        }
      } else if (event.key.startsWith(PRESENCE_PREFIX)) {
        setPeers(listPeers())
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // 活动会话变化时保持本地状态（meta.activeMergeId 可能来自重开恢复或对方发起）。
  useEffect(() => {
    setActiveSession(meta.activeMergeId ? readSession(meta.activeMergeId) : null)
  }, [meta.activeMergeId])

  // 对方完成合并后，本页依据 completedMergeId 可靠采用合并稿（先把合并前状态压入撤销栈）。
  const adoptedMergesRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const completedId = meta.completedMergeId
    if (!completedId || adoptedMergesRef.current.has(completedId)) return
    const session = readSession(completedId)
    if (!session || session.status !== 'completed' || !session.result) return
    const participant = session.peerA.peer.id === peerIdRef.current || session.peerB.peer.id === peerIdRef.current
    if (!participant) return
    adoptedMergesRef.current.add(completedId)
    setState((previous) => {
      undoRef.current.push({ script: clone(previous.script), reviews: clone(previous.reviews) })
      redoRef.current = []
      const versions = previous.versions.some((version) => version.id === session.preMergeVersionId)
        ? previous.versions
        : [session.preMergeVersion, ...previous.versions]
      return {
        ...previous,
        script: clone(session.result!.script),
        reviews: clone(session.result!.reviews),
        versions,
        updatedAt: new Date().toISOString()
      }
    })
    setLastOrphans(session.orphanResults ?? [])
    localStorage.removeItem(draftKey(peerIdRef.current))
    localStorage.removeItem(PRESENCE_PREFIX + peerIdRef.current)
    setActiveSession(null)
    setPeers(listPeers())
  }, [meta.completedMergeId])

  const pushHistory = useCallback((previous: ContinuityState) => {
    undoRef.current.push({ script: clone(previous.script), reviews: clone(previous.reviews) })
    if (undoRef.current.length > 80) undoRef.current.shift()
    redoRef.current = []
  }, [])

  const mutate = useCallback((mutator: (script: Script) => void) => {
    setState((previous) => {
      const peer = listPeers().find((item) => item.id === peerIdRef.current)
      if (loadMeta().base && peer?.role === 'review') return previous // 协作所有权：剧本归场景场记
      const next = clone(previous.script)
      mutator(next)
      pushHistory(previous)
      return { ...previous, script: next, updatedAt: new Date().toISOString() }
    })
  }, [pushHistory])

  const undo = useCallback(() => {
    setState((previous) => {
      const target = undoRef.current.pop()
      if (!target) return previous
      redoRef.current.push({ script: clone(previous.script), reviews: clone(previous.reviews) })
      return { ...previous, script: target.script, reviews: target.reviews, updatedAt: new Date().toISOString() }
    })
  }, [])

  const redo = useCallback(() => {
    setState((previous) => {
      const target = redoRef.current.pop()
      if (!target) return previous
      undoRef.current.push({ script: clone(previous.script), reviews: clone(previous.reviews) })
      return { ...previous, script: target.script, reviews: target.reviews, updatedAt: new Date().toISOString() }
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
    const sceneId = newId('scene')
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
    if (stateRef.current.script.scenes.length <= 1) return
    mutate((script) => { script.scenes = script.scenes.filter((scene) => scene.id !== sceneId) })
  }, [mutate])

  const addCharacter = useCallback(() => {
    mutate((script) => {
      script.characters.push({ id: newId('char'), name: '新角色', actor: '待定', introducedSceneId: script.scenes[0]?.id ?? '', note: '' })
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
      script.props.push({ id: newId('prop'), name: '新道具', introducedSceneId: script.scenes[0]?.id ?? '', ownerId: script.characters[0]?.id ?? '', note: '' })
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
      script.wardrobes.push({ id: newId('ward'), characterId: script.characters[0]?.id ?? '', name: '新服装', timePeriods: ['白天'], note: '' })
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

  const mutateReview = useCallback((warningId: string, updater: (review: WarningReview) => WarningReview) => {
    setState((previous) => {
      const peer = listPeers().find((item) => item.id === peerIdRef.current)
      if (loadMeta().base && peer?.role === 'script') return previous // 协作所有权：警告/回复归审阅场记
      pushHistory(previous)
      const current = previous.reviews[warningId] ?? { status: 'pending' as const, replies: [] }
      return {
        ...previous,
        reviews: { ...previous.reviews, [warningId]: { ...updater(current), updatedAt: new Date().toISOString() } },
        updatedAt: new Date().toISOString()
      }
    })
  }, [pushHistory])

  const setReviewStatus = useCallback((warningId: string, status: WarningReview['status']) => {
    mutateReview(warningId, (review) => ({ ...review, status }))
  }, [mutateReview])

  const addReply = useCallback((warningId: string, author: string, text: string) => {
    if (!text.trim()) return
    const reply: Reply = { id: newId('reply'), author, text: text.trim(), createdAt: new Date().toISOString() }
    mutateReview(warningId, (review) => ({ ...review, replies: [...review.replies, reply] }))
  }, [mutateReview])

  const createVersion = useCallback((name: string, options?: { preMerge?: boolean }) => {
    const version: Version = {
      id: newId('version'),
      name: name.trim() || `版本 ${stateRef.current.versions.length + 1}`,
      createdAt: new Date().toISOString(),
      script: clone(stateRef.current.script),
      reviews: clone(stateRef.current.reviews),
      preMerge: options?.preMerge
    }
    setState((previous) => ({ ...previous, versions: [version, ...previous.versions] }))
    return version
  }, [])

  const restoreVersion = useCallback((versionId: string) => {
    setState((previous) => {
      const version = previous.versions.find((item) => item.id === versionId)
      if (!version) return previous
      pushHistory(previous)
      return {
        ...previous,
        script: clone(version.script),
        reviews: version.reviews ? clone(version.reviews) : previous.reviews,
        updatedAt: new Date().toISOString()
      }
    })
  }, [pushHistory])

  const reset = useCallback(() => {
    setState((previous) => {
      pushHistory(previous)
      return { ...previous, script: clone(sampleScript), reviews: {}, updatedAt: new Date().toISOString() }
    })
  }, [pushHistory])

  // ---- 协作会话 ----

  const joinCollab = useCallback((chosenRole: PeerRole) => {
    const current = stateRef.current
    const peerId = peerIdRef.current
    const online = listPeers()
    if (online.some((peer) => peer.role === chosenRole && peer.id !== peerId)) return false
    const now = new Date().toISOString()
    const label = chosenRole === 'script' ? '场记甲 · 场景/道具/服装' : '场记乙 · 警告/回复'

    let currentMeta = loadMeta()
    if (!currentMeta.base) {
      // 第一个加入的标签页冻结共同原稿（剧本 + 审阅决定 + 历史版本）
      currentMeta = {
        base: { script: clone(current.script), reviews: clone(current.reviews), versions: clone(current.versions), savedAt: now },
        activeMergeId: null,
        completedMergeId: null
      }
      saveMeta(currentMeta)
    }
    const peer: Peer = { id: peerId, role: chosenRole, label, startedAt: now, lastSeenAt: now }
    writePresence(peer)
    writeDraft(peerId, { peerId, role: chosenRole, label, script: clone(current.script), reviews: clone(current.reviews), updatedAt: now })
    setMeta(loadMeta())
    setPeers(listPeers())
    return true
  }, [])

  /**
   * 整页彻底关闭后重开（新标签页身份），而未决合并会话还在：用本标签页顶替某个参与者槽位。
   * 待选定内容随会话落盘，不会丢；本标签页的当前工作稿不再参与本场合并（以会话里冻结的两稿为准）。
   */
  const reattachMerge = useCallback((asRole: PeerRole): boolean => {
    const currentMeta = loadMeta()
    if (!currentMeta.base || !currentMeta.activeMergeId) return false
    const session = readSession(currentMeta.activeMergeId)
    if (!session || session.status !== 'open') return false
    const slotKey = asRole === 'script' ? 'peerA' : 'peerB'
    const targetPeer = session[slotKey].peer
    const now = new Date().toISOString()
    const peer: Peer = { ...targetPeer, id: peerIdRef.current, startedAt: now, lastSeenAt: now }
    writePresence(peer)
    writeDraft(peer.id, {
      peerId: peer.id,
      role: peer.role,
      label: peer.label,
      script: clone(session[slotKey].script),
      reviews: clone(session[slotKey].reviews),
      updatedAt: now
    })
    // 把会话槽位身份改成本标签页，保证完成合并后的自动采用能识别到顶替者。
    writeSession({ ...session, [slotKey]: { ...session[slotKey], peer } })
    setMeta(loadMeta())
    setActiveSession(readSession(session.id))
    setPeers(listPeers())
    return true
  }, [])

  const leaveCollab = useCallback(() => {
    const peerId = peerIdRef.current
    localStorage.removeItem(draftKey(peerId))
    localStorage.removeItem(PRESENCE_PREFIX + peerId)
    // 双方都离开后清空协作基线
    window.setTimeout(() => {
      if (listPeers().length === 0) {
        saveMeta({ ...loadMeta(), base: null, activeMergeId: null })
        setMeta(loadMeta())
      }
      setPeers(listPeers())
    }, 0)
    setPeers(listPeers())
  }, [])

  const startMerge = useCallback((): { ok: boolean; reason?: string } => {
    const currentMeta = loadMeta()
    if (!currentMeta.base) return { ok: false, reason: '协作尚未开始' }
    const online = listPeers()
    const byRole = (peerRole: PeerRole) => online.find((peer) => peer.role === peerRole)
    const scriptPeer = byRole('script')
    const reviewPeer = byRole('review')
    if (!scriptPeer || !reviewPeer) return { ok: false, reason: '两名场记都在线才能合并，请等待另一个标签页加入。' }

    let draftA = readDraft(scriptPeer.id)
    let draftB = readDraft(reviewPeer.id)
    if (!draftA || !draftB) return { ok: false, reason: '缺少一方的工作稿，请确认两边都已自动保存。' }

    // 发起方自己的草稿槽可能还没等到防抖落盘，用当前内存里的实时工作稿顶替。
    const ownId = peerIdRef.current
    const liveNow = new Date().toISOString()
    if (scriptPeer.id === ownId) {
      draftA = { peerId: ownId, role: 'script', label: scriptPeer.label, script: clone(stateRef.current.script), reviews: clone(stateRef.current.reviews), updatedAt: liveNow }
      writeDraft(ownId, draftA)
    } else if (reviewPeer.id === ownId) {
      draftB = { peerId: ownId, role: 'review', label: reviewPeer.label, script: clone(stateRef.current.script), reviews: clone(stateRef.current.reviews), updatedAt: liveNow }
      writeDraft(ownId, draftB)
    }

    // 合并开始即冻结合并前完整稿快照（剧本 + 审阅决定 + 回复）
    const preMergeVersion: Version = {
      id: newId('version'),
      name: `合并前完整稿 · ${new Date().toLocaleString('zh-CN')}`,
      createdAt: new Date().toISOString(),
      script: clone(stateRef.current.script),
      reviews: clone(stateRef.current.reviews),
      preMerge: true
    }

    const plan = computeMerge({
      base: currentMeta.base,
      scriptA: draftA.script,
      scriptB: draftB.script,
      reviewsA: draftA.reviews,
      reviewsB: draftB.reviews
    })

    const session: MergeSession = {
      id: newId('merge'),
      createdAt: new Date().toISOString(),
      base: clone(currentMeta.base),
      peerA: { peer: scriptPeer, script: clone(draftA.script), reviews: clone(draftA.reviews) },
      peerB: { peer: reviewPeer, script: clone(draftB.script), reviews: clone(draftB.reviews) },
      conflicts: plan.conflicts,
      orphanReviews: [],
      autoChanges: plan.autoChanges,
      preMergeVersionId: preMergeVersion.id,
      preMergeVersion,
      status: 'open'
    }
    writeSession(session)
    saveMeta({ ...currentMeta, activeMergeId: session.id })
    setState((previous) => ({ ...previous, versions: [preMergeVersion, ...previous.versions] }))
    setMeta(loadMeta())
    setActiveSession(session)
    return { ok: true }
  }, [])

  const updateSession = useCallback((updater: (session: MergeSession) => MergeSession) => {
    const currentMeta = loadMeta()
    if (!currentMeta.activeMergeId) return
    const session = readSession(currentMeta.activeMergeId)
    if (!session || session.status !== 'open') return
    const next = updater(session)
    // 双方可能同时在各自标签页选定：落盘前重读最新会话，把对方刚写入的选定合并进来。
    const latest = readSession(currentMeta.activeMergeId)
    let merged = next
    if (latest && latest !== session) {
      merged = {
        ...next,
        conflicts: next.conflicts.map((conflict) => {
          const theirs = latest.conflicts.find((item) => item.entity === conflict.entity && item.id === conflict.id)
          if (!theirs) return conflict
          return {
            ...conflict,
            resolution: conflict.resolution ?? theirs.resolution,
            fields: conflict.fields.map((field) => ({ ...field, resolution: field.resolution ?? theirs.fields.find((item) => item.key === field.key)?.resolution }))
          }
        })
      }
    }
    writeSession(merged)
    setActiveSession(merged)
  }, [])

  const resolveConflictField = useCallback((entity: EntityConflict['entity'], conflictId: string, fieldKey: string, side: ConflictSide) => {
    updateSession((session) => ({
      ...session,
      conflicts: session.conflicts.map((conflict) =>
        conflict.entity === entity && conflict.id === conflictId
          ? { ...conflict, fields: conflict.fields.map((field) => (field.key === fieldKey ? { ...field, resolution: side } : field)) }
          : conflict)
    }))
  }, [updateSession])

  const resolveConflictEntity = useCallback((entity: EntityConflict['entity'], conflictId: string, side: ConflictSide) => {
    updateSession((session) => ({
      ...session,
      conflicts: session.conflicts.map((conflict) =>
        conflict.entity === entity && conflict.id === conflictId
          ? { ...conflict, resolution: side, fields: conflict.fields.map((field) => ({ ...field, resolution: side })) }
          : conflict)
    }))
  }, [updateSession])

  const completeMerge = useCallback((): { ok: boolean; reason?: string } => {
    const currentMeta = loadMeta()
    if (!currentMeta.activeMergeId) return { ok: false, reason: '没有进行中的合并' }
    const session = readSession(currentMeta.activeMergeId)
    if (!session || session.status !== 'open') return { ok: false, reason: '合并会话已失效' }
    if (unresolvedConflicts(session.conflicts).length > 0) return { ok: false, reason: '还有同字段改动没有选定保留哪一版。' }

    let mergedScript: Script
    let reviewResult: { reviews: Record<string, WarningReview>; orphanReviews: OrphanReview[] }
    try {
      mergedScript = buildMergedScript(session.base.script, session.peerA.script, session.peerB.script, session.conflicts)
      reviewResult = buildMergedReviews(
        session.base,
        session.peerA.script,
        session.peerB.script,
        mergedScript,
        session.peerA.reviews,
        session.peerB.reviews,
        session.conflicts
      )
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : '合并失败' }
    }

    const completed: MergeSession = {
      ...session,
      status: 'completed',
      resolvedAt: new Date().toISOString(),
      orphanReviews: reviewResult.orphanReviews,
      orphanResults: reviewResult.orphanReviews,
      result: { script: mergedScript, reviews: reviewResult.reviews }
    }
    writeSession(completed)
    saveMeta({ base: null, activeMergeId: null, completedMergeId: session.id })

    // 发起方立即采用合并稿，并把合并前完整稿压入撤销栈
    setState((previous) => {
      undoRef.current.push({ script: clone(previous.script), reviews: clone(previous.reviews) })
      redoRef.current = []
      return { ...previous, script: clone(mergedScript), reviews: clone(reviewResult.reviews), updatedAt: new Date().toISOString() }
    })
    setLastOrphans(reviewResult.orphanReviews)
    adoptedMergesRef.current.add(session.id)
    localStorage.removeItem(draftKey(peerIdRef.current))
    localStorage.removeItem(PRESENCE_PREFIX + peerIdRef.current)
    setMeta(loadMeta())
    setActiveSession(null)
    setPeers(listPeers())
    return { ok: true }
  }, [])

  const cancelMerge = useCallback(() => {
    const currentMeta = loadMeta()
    if (!currentMeta.activeMergeId) return
    const session = readSession(currentMeta.activeMergeId)
    if (session) {
      writeSession({ ...session, status: 'cancelled', resolvedAt: new Date().toISOString() })
    }
    saveMeta({ ...currentMeta, activeMergeId: null })
    setMeta(loadMeta())
    setActiveSession(null)
  }, [])

  const collab: CollabView = {
    peerId: peerIdRef.current,
    joined,
    role,
    peers,
    canEditScript: !joined || role === 'script',
    canReview: !joined || role === 'review',
    activeSession,
    recoverableMerge:
      activeSession && activeSession.status === 'open' && !joined
        ? activeSession
        : null,
    lastOrphans
  }

  return {
    state,
    saveStatus,
    warnings: deriveWarnings(state.script),
    collab,
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
    undo,
    redo,
    reset,
    joinCollab,
    reattachMerge,
    leaveCollab,
    startMerge,
    resolveConflictField,
    resolveConflictEntity,
    completeMerge,
    cancelMerge
  }
}

export { deriveWarnings, deepEqual }
