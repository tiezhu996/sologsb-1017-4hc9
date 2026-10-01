export type RevisionColor = 'white' | 'blue' | 'pink' | 'yellow' | 'green' | 'goldenrod' | 'buff' | 'salmon' | 'cherry'
export type WarningStatus = 'pending' | 'accepted' | 'ignored'
export type WarningType = 'character' | 'prop' | 'wardrobe' | 'timeline'
export type WorkspaceRole = 'production' | 'review'
export type MergeSide = WorkspaceRole

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
}

export interface DraftSnapshot {
  script: Script
  reviews: Record<string, WarningReview>
}

export interface Version {
  id: string
  name: string
  createdAt: string
  script: Script
  reviews?: Record<string, WarningReview>
  mergeSnapshot?: {
    production: DraftSnapshot
    review: DraftSnapshot
  }
  mergeBaseVersionId?: string
}

export interface WorkspaceInfo {
  id: string
  name: string
  role: WorkspaceRole
  partnerId?: string
  baseVersionId?: string
  startedAt: string
}

export interface WorkspaceSummary extends WorkspaceInfo {
  updatedAt: string
}

export type MergeConflictScope = 'script' | 'scene' | 'character' | 'prop' | 'wardrobe'
export type MergeConflictKind = 'field' | 'entity' | 'order'

export interface MergeConflict {
  id: string
  kind: MergeConflictKind
  scope: MergeConflictScope
  entityId?: string
  entityLabel?: string
  field: string
  fieldLabel: string
  base: unknown
  production: unknown
  review: unknown
  resolution: MergeSide | null
}

export interface MergeAutoChange {
  id: string
  label: string
  detail: string
  side: MergeSide | 'both'
}

export interface MergeSession {
  id: string
  name: string
  startedAt: string
  preMergeVersionId: string
  baseVersionId: string
  productionWorkspaceId: string
  productionWorkspaceName: string
  reviewWorkspaceId: string
  reviewWorkspaceName: string
  productionDraft: DraftSnapshot
  reviewDraft: DraftSnapshot
  mergedScript: Script
  conflicts: MergeConflict[]
  autoChanges: MergeAutoChange[]
}

export interface OrphanReview {
  warningId: string
  warning?: WarningItem
  review: WarningReview
  reason: string
}

export interface MergeReport {
  id: string
  completedAt: string
  preMergeVersionId: string
  autoMergedCount: number
  conflictCount: number
  migratedReviews: Record<string, WarningReview>
  orphanReviews: OrphanReview[]
}

export interface ContinuityState {
  script: Script
  reviews: Record<string, WarningReview>
  versions: Version[]
  updatedAt: string
  workspace: WorkspaceInfo
  activeMerge?: MergeSession | null
  lastMerge?: MergeReport | null
}

export interface DiffItem {
  id: string
  sceneNumber: string
  field: string
  before: string
  after: string
}
