export type RevisionColor = 'white' | 'blue' | 'pink' | 'yellow' | 'green' | 'goldenrod' | 'buff' | 'salmon' | 'cherry'
export type WarningStatus = 'pending' | 'accepted' | 'ignored'
export type WarningType = 'character' | 'prop' | 'wardrobe' | 'timeline'

export interface Character {
  id: string
  name: string
  actor: string
  introducedSceneId: string
  note: string
}

export interface Prop {
  id: string
  name: string
  introducedSceneId: string
  ownerId: string
  note: string
}

export interface Wardrobe {
  id: string
  characterId: string
  name: string
  timePeriods: string[]
  note: string
}

export interface Scene {
  id: string
  number: string
  slug: string
  synopsis: string
  intExt: 'INT' | 'EXT' | 'INT/EXT'
  location: string
  dayNight: string
  storyTime: string
  pageLength: number
  characterIds: string[]
  propIds: string[]
  costumes: Record<string, string>
  revision: RevisionColor
  status: 'draft' | 'review' | 'locked'
  reason: string
}

export interface Script {
  title: string
  writer: string
  draft: string
  scenes: Scene[]
  characters: Character[]
  props: Prop[]
  wardrobes: Wardrobe[]
}

export interface WarningItem {
  id: string
  type: WarningType
  severity: 'error' | 'warning'
  sceneId: string
  title: string
  detail: string
  suggestion: string
}

export interface Reply {
  id: string
  author: string
  text: string
  createdAt: string
}

export interface WarningReview {
  status: WarningStatus
  replies: Reply[]
  updatedAt?: string
}

export interface Version {
  id: string
  name: string
  createdAt: string
  script: Script
  /** 合并前快照会连同审阅决定与回复一起冻结；旧版本可缺省 */
  reviews?: Record<string, WarningReview>
  preMerge?: boolean
}

export interface ContinuityState {
  script: Script
  reviews: Record<string, WarningReview>
  versions: Version[]
  updatedAt: string
}

export interface DiffItem {
  id: string
  sceneNumber: string
  field: string
  before: string
  after: string
}

// ---- 双标签页协作合并 ----

export type PeerRole = 'script' | 'review'

export interface Peer {
  id: string
  role: PeerRole
  label: string
  startedAt: string
  lastSeenAt: string
}

/** 某一标签页脱离共享基线后的工作稿 */
export interface DraftBranch {
  peerId: string
  role: PeerRole
  label: string
  script: Script
  reviews: Record<string, WarningReview>
  updatedAt: string
}

/** 三方合并的共同原稿：剧本与审阅决定各持一份 */
export interface MergeBase {
  script: Script
  reviews: Record<string, WarningReview>
  versions: Version[]
  savedAt: string
}

export type ConflictSide = 'a' | 'b'
export type MergeEntity = 'scene' | 'character' | 'prop' | 'wardrobe' | 'meta' | 'review'
export type MergeChangeKind = 'added' | 'removed' | 'modified'

export interface FieldConflict {
  key: string
  label: string
  base: unknown
  a: unknown
  b: unknown
  resolution?: ConflictSide
}

export interface EntityConflict {
  id: string
  entity: MergeEntity
  /** 新增撞 id、删除对修改、修改对删除等情形；普通同字段冲突留空 */
  reason?: 'both-added-differently' | 'removed-vs-modified' | 'modified-vs-removed'
  baseName: string
  aName: string
  bName: string
  a: unknown
  b: unknown
  /** 删除对修改等整条冲突时选择整条保留哪一版 */
  resolution?: ConflictSide
  fields: FieldConflict[]
}

export interface AutoChange {
  entity: MergeEntity
  id: string
  name: string
  kind: MergeChangeKind
  side: ConflictSide
  fields: string[]
}

/** 合并稿中找不到对应警告的审阅决定（不套到新场景，也不丢弃） */
export interface OrphanReview {
  warningId: string
  warningTitle: string
  side: ConflictSide
  review: WarningReview
}

export interface MergeSession {
  id: string
  createdAt: string
  base: MergeBase
  peerA: { peer: Peer; script: Script; reviews: Record<string, WarningReview> }
  peerB: { peer: Peer; script: Script; reviews: Record<string, WarningReview> }
  conflicts: EntityConflict[]
  orphanReviews: OrphanReview[]
  autoChanges: AutoChange[]
  /** 合并开始时落盘的合并前完整稿快照 id */
  preMergeVersionId: string
  /** 合并前完整稿快照本体，供另一个标签页采用合并稿时一并归档 */
  preMergeVersion: Version
  status: 'open' | 'completed' | 'cancelled'
  resolvedAt?: string
  /** 完成后的最终结果，供另一个标签页自动采用 */
  result?: {
    script: Script
    reviews: Record<string, WarningReview>
  }
  orphanResults?: OrphanReview[]
}

export interface CollabState {
  peerId: string
  role: PeerRole
  peers: Record<string, Peer>
  base: MergeBase | null
  drafts: Record<string, DraftBranch>
  activeMergeId: string | null
  mergeSessions: Record<string, MergeSession>
}

