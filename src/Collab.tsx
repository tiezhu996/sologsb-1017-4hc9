import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  Paper,
  Stack,
  Typography
} from '@mui/material'
import {
  CallMerge,
  Block,
  CheckCircle,
  Close,
  DeleteOutline,
  EditNote,
  FactCheck,
  History,
  LinkOff,
  PeopleAlt
} from '@mui/icons-material'
import { SIDE_LABEL, unresolvedConflicts } from './merge'
import type { useContinuityStore } from './store'
import type {
  AutoChange,
  ConflictSide,
  EntityConflict,
  MergeSession,
  OrphanReview,
  Script,
  WarningReview
} from './types'

export const OPEN_COLLAB_EVENT = 'sologsb:open-collab'

type Store = ReturnType<typeof useContinuityStore>

const ENTITY_LABEL: Record<AutoChange['entity'], string> = {
  scene: '场景',
  character: '角色',
  prop: '道具',
  wardrobe: '服装',
  meta: '剧本信息',
  review: '审阅决定'
}
const KIND_LABEL: Record<AutoChange['kind'], string> = {
  added: '新增',
  removed: '删除',
  modified: '修改'
}
const STATUS_LABEL: Record<WarningReview['status'], string> = {
  pending: '待审',
  accepted: '已接受',
  ignored: '已忽略'
}

function useNameResolver(session: MergeSession | null) {
  return useMemo(() => {
    if (!session) {
      const identity = (id: string) => id
      const emptyChars: Script['characters'][] = [[]]
      const emptyProps: Script['props'][] = [[]]
      const emptyWards: Script['wardrobes'][] = [[]]
      const emptyScenes: Script['scenes'][] = [[]]
      return {
        characters: emptyChars, props: emptyProps, wardrobes: emptyWards, scenes: emptyScenes,
        character: identity,
        prop: identity,
        wardrobe: identity,
        scene: identity
      }
    }
    const scripts: Script[] = [session.base.script, session.peerA.script, session.peerB.script]
    const findIn = <T extends { id: string; name?: string; number?: string; slug?: string }>(list: T[][], id: string, fallback?: (item: T) => string) => {
      for (const items of list) {
        const hit = items.find((item) => item.id === id)
        if (hit) return fallback ? fallback(hit) : String(hit.name ?? id)
      }
      return id
    }
    const characters = scripts.map((script) => script.characters)
    const props = scripts.map((script) => script.props)
    const wardrobes = scripts.map((script) => script.wardrobes)
    const scenes = scripts.map((script) => script.scenes)
    return {
      characters, props, wardrobes, scenes,
      character: (id: string) => findIn(characters, id),
      prop: (id: string) => findIn(props, id),
      wardrobe: (id: string) => findIn(wardrobes, id),
      scene: (id: string) => findIn(scenes, id, (item) => `场景 ${item.number} · ${item.slug}`)
    }
  }, [session])
}

function formatValue(fieldKey: string, value: unknown, resolver: ReturnType<typeof useNameResolver>): string {
  if (value === undefined || value === null || value === '') return '（空）'
  if (fieldKey === 'status') return STATUS_LABEL[value as WarningReview['status']] ?? String(value)
  if (Array.isArray(value)) {
    if (fieldKey === 'characterIds') return value.map((id) => resolver.character(String(id))).join('、') || '（无）'
    if (fieldKey === 'propIds') return value.map((id) => resolver.prop(String(id))).join('、') || '（无）'
    return value.join('、') || '（无）'
  }
  if (fieldKey === 'costumes' && typeof value === 'object') {
    return Object.entries(value as Record<string, string>).map(([characterId, wardrobeId]) =>
      `${resolver.character(characterId)}：${resolver.wardrobe(wardrobeId)}`
    ).join('；') || '（无）'
  }
  if (fieldKey === 'introducedSceneId') return resolver.scene(String(value))
  if (fieldKey === 'ownerId') return resolver.character(String(value))
  if (fieldKey === 'characterId') return resolver.character(String(value))
  return String(value)
}

function SideChoice({
  label,
  chosen,
  onChoose,
  children
}: {
  label: string
  chosen: boolean
  onChoose: () => void
  children: React.ReactNode
}) {
  return (
    <Paper elevation={0} className={`merge-side ${chosen ? 'chosen' : ''}`} onClick={onChoose} role="button" tabIndex={0}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onChoose() }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" mb={0.5}>
        <Typography variant="caption" fontWeight={750}>{label}</Typography>
        {chosen ? <CheckCircle fontSize="small" color="success" /> : <Chip size="small" label="选用此版" variant="outlined" />}
      </Stack>
      <Box className="merge-side-value">{children}</Box>
    </Paper>
  )
}

function ConflictCard({
  conflict,
  store,
  resolver
}: {
  conflict: EntityConflict
  store: Store
  resolver: ReturnType<typeof useNameResolver>
}) {
  const entityLevel = !!conflict.reason
  const deletingSide: ConflictSide | null =
    conflict.reason === 'removed-vs-modified' ? 'a' : conflict.reason === 'modified-vs-removed' ? 'b' : null

  return (
    <Paper className={`merge-conflict ${conflict.fields.every((field) => field.resolution) && (entityLevel ? conflict.resolution : true) ? 'is-resolved' : ''}`} elevation={0}>
      <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
        <Chip size="small" color="warning" label={ENTITY_LABEL[conflict.entity]} />
        <Typography fontWeight={750}>{conflict.baseName !== '（共同原稿中不存在）' ? conflict.baseName : '新增条目（两版不同）'}</Typography>
        {entityLevel && (
          <Chip size="small" variant="outlined" label={conflict.reason === 'both-added-differently' ? '双方都新增且内容不同' : '一方删除、另一方修改'} />
        )}
      </Stack>

      {entityLevel && (
        <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} mt={1.5}>
          {(['a', 'b'] as ConflictSide[]).map((side) => {
            const sideEntity = side === 'a' ? conflict.a : conflict.b
            const deleted = sideEntity === undefined
            return (
              <Button
                key={side}
                fullWidth
                variant={conflict.resolution === side ? 'contained' : 'outlined'}
                color={deleted ? 'error' : 'primary'}
                startIcon={deleted ? <DeleteOutline /> : <EditNote />}
                onClick={() => store.resolveConflictEntity(conflict.entity, conflict.id, side)}
              >
                {deleted
                  ? `${SIDE_LABEL[side]}：${deletingSide === side ? '确认删除整条' : '此版已删除'}`
                  : `${SIDE_LABEL[side]}：保留修改后的整条（${side === 'a' ? conflict.aName : conflict.bName}）`}
              </Button>
            )
          })}
        </Stack>
      )}

      {!entityLevel && (
        <Stack gap={1.5} mt={1.5}>
          {conflict.fields.map((field) => (
            <Box key={field.key}>
              <Typography className="section-label">{field.label}{field.resolution && <Chip size="small" sx={{ ml: 1 }} label={`已选${field.resolution === 'a' ? '甲' : '乙'}版`} color="success" />}</Typography>
              <Box className="merge-side-grid">
                <SideChoice label={SIDE_LABEL.a} chosen={field.resolution === 'a'} onChoose={() => store.resolveConflictField(conflict.entity, conflict.id, field.key, 'a')}>
                  {formatValue(field.key, field.a, resolver)}
                </SideChoice>
                <SideChoice label={SIDE_LABEL.b} chosen={field.resolution === 'b'} onChoose={() => store.resolveConflictField(conflict.entity, conflict.id, field.key, 'b')}>
                  {formatValue(field.key, field.b, resolver)}
                </SideChoice>
              </Box>
            </Box>
          ))}
        </Stack>
      )}

      {entityLevel && conflict.reason === 'both-added-differently' && (
        <Box mt={1.5}>
          <Typography variant="caption" color="text.secondary">也可逐字段挑选（不选整条时）：</Typography>
          <Stack gap={1.2} mt={1}>
            {conflict.fields.map((field) => (
              <Box key={field.key} className="merge-field-row">
                <Typography className="section-label">{field.label}</Typography>
                <Box className="merge-side-grid compact">
                  <SideChoice label={SIDE_LABEL.a} chosen={field.resolution === 'a'} onChoose={() => store.resolveConflictField(conflict.entity, conflict.id, field.key, 'a')}>
                    {formatValue(field.key, field.a, resolver)}
                  </SideChoice>
                  <SideChoice label={SIDE_LABEL.b} chosen={field.resolution === 'b'} onChoose={() => store.resolveConflictField(conflict.entity, conflict.id, field.key, 'b')}>
                    {formatValue(field.key, field.b, resolver)}
                  </SideChoice>
                </Box>
              </Box>
            ))}
          </Stack>
        </Box>
      )}
    </Paper>
  )
}

function AutoChangeList({ changes }: { changes: AutoChange[] }) {
  if (!changes.length) return <Alert severity="success">没有无冲突的自动改动，两边都只改了审阅决定或完全一致。</Alert>
  return (
    <List dense disablePadding className="merge-auto-list">
      {changes.map((change, index) => (
        <ListItem key={`${change.entity}-${change.id}-${index}`} disableGutters>
          <Chip size="small" sx={{ mr: 1 }} color={change.side === 'a' ? 'primary' : 'secondary'} label={change.side === 'a' ? '甲稿' : '乙稿'} />
          <Chip size="small" sx={{ mr: 1 }} variant="outlined" label={ENTITY_LABEL[change.entity]} />
          <Chip size="small" sx={{ mr: 1 }} color={change.kind === 'removed' ? 'error' : change.kind === 'added' ? 'success' : 'default'} label={KIND_LABEL[change.kind]} />
          <Typography variant="body2">{change.name}</Typography>
          {change.fields.length > 0 && <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>（{change.fields.join('、')}）</Typography>}
        </ListItem>
      ))}
    </List>
  )
}

function OrphanList({ orphans }: { orphans: OrphanReview[] }) {
  if (!orphans.length) return <Alert severity="success">所有审阅决定都仍对应合并稿中的同一条警告，没有脱离的决定。</Alert>
  return (
    <Stack gap={1}>
      <Alert severity="warning" icon={<LinkOff />}>
        以下 {orphans.length} 条审阅状态或回复在合并稿中已找不到同一条警告（对应场景被删除或改到不再触发）。它们不会套用到任何新场景上，已随“合并前完整稿”快照与本次合并记录归档保留。
      </Alert>
      {orphans.map((orphan, index) => (
        <Paper key={`${orphan.warningId}-${orphan.side}-${index}`} className="merge-orphan" elevation={0}>
          <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
            <Chip size="small" color={orphan.side === 'a' ? 'primary' : 'secondary'} label={orphan.side === 'a' ? '来自甲稿' : '来自乙稿'} />
            <Typography fontWeight={700}>{orphan.warningTitle}</Typography>
            <Chip size="small" label={STATUS_LABEL[orphan.review.status]} />
          </Stack>
          {orphan.review.replies.map((reply) => (
            <Typography key={reply.id} variant="body2" color="text.secondary" mt={0.5}>
              {reply.author}：{reply.text}
            </Typography>
          ))}
        </Paper>
      ))}
    </Stack>
  )
}

function MergeDialog({ store, open, onClose }: { store: Store; open: boolean; onClose: () => void }) {
  const liveSession = store.collab.activeSession
  // 完成瞬间活动会话会被清空，这里冻结一份快照用于展示完成结果与脱离清单。
  const [frozen, setFrozen] = useState<MergeSession | null>(null)
  const [completed, setCompleted] = useState(false)
  const [error, setError] = useState('')
  const session = liveSession ?? frozen
  const resolver = useNameResolver(liveSession)

  useEffect(() => {
    if (open) { setCompleted(false); setError(''); setFrozen(null) }
  }, [open])

  if (open && !session) return null

  const pending = liveSession ? unresolvedConflicts(liveSession.conflicts) : []
  const handleComplete = () => {
    if (!liveSession) return
    const snapshot = liveSession
    const result = store.completeMerge()
    if (result.ok) {
      setFrozen(snapshot)
      setCompleted(true)
    } else {
      setError(result.reason ?? '合并未完成')
    }
  }

  if (!session) return null

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="lg" className="merge-dialog">
      <DialogTitle>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Box>
            <Typography variant="h6">断网恢复 · 合并两名场记的工作稿</Typography>
            <Typography variant="caption" color="text.secondary">
              共同原稿冻结于 {new Date(session.base.savedAt).toLocaleString('zh-CN')} · 甲稿：{session.peerA.peer.label} · 乙稿：{session.peerB.peer.label}
            </Typography>
          </Box>
          <IconButton onClick={onClose}><Close /></IconButton>
        </Stack>
      </DialogTitle>
      <DialogContent>
        {completed ? (
          <Stack gap={2}>
            <Alert severity="success" icon={<CheckCircle />}>
              合并已完成并自动保存到两个标签页。按 Ctrl/⌘ + Z，或在“版本差异”中恢复“合并前完整稿”，都可以回到合并前。
            </Alert>
            <Box>
              <Typography variant="h6" mb={1}>脱离的审阅决定（未套用到新场景）</Typography>
              <OrphanList orphans={store.collab.lastOrphans} />
            </Box>
          </Stack>
        ) : (
          <Stack gap={2}>
            <Alert severity="info" icon={<History />}>
              已先保存“合并前完整稿”快照（含全部审阅状态与回复）。即使现在关闭页面，重开后仍可继续选定；撤销也能回到合并前。
            </Alert>
            {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}

            <Paper className="merge-section" elevation={0}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
                <Typography variant="h6">① 无冲突改动 · 自动合入（{session.autoChanges.length}）</Typography>
                <Chip size="small" label="场景、道具、服装、角色互不重叠的改动" variant="outlined" />
              </Stack>
              <AutoChangeList changes={session.autoChanges} />
            </Paper>

            <Paper className="merge-section" elevation={0}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
                <Typography variant="h6">② 同一字段两边都改过 · 保留两版由你选定（{session.conflicts.length}）</Typography>
                <Chip size="small" color={pending.length ? 'warning' : 'success'} label={pending.length ? `待选定 ${pending.length}` : '已全部选定'} />
              </Stack>
              {session.conflicts.length === 0 && <Alert severity="success">没有字段打架。</Alert>}
              <Stack gap={1.5}>
                {session.conflicts.map((conflict) => (
                  <ConflictCard key={`${conflict.entity}-${conflict.id}`} conflict={conflict} store={store} resolver={resolver} />
                ))}
              </Stack>
            </Paper>

            <Alert severity="warning">
              警告与回复跟随各自版本：只有合并稿里仍存在的同一条警告才保留决定，新场景不会继承旧警告的接受/忽略状态或回复。
            </Alert>
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap' }}>
        {completed ? (
          <Button variant="contained" onClick={onClose}>完成</Button>
        ) : (
          <>
            <Typography variant="caption" color="text.secondary" sx={{ mr: 'auto' }}>中断或关闭页面后重开，待选定内容不会丢失。</Typography>
            <Button color="inherit" startIcon={<Block />} onClick={() => { store.cancelMerge(); onClose() }}>放弃本次合并</Button>
            <Button variant="contained" startIcon={<CallMerge />} disabled={pending.length > 0} onClick={handleComplete}>
              {pending.length > 0 ? `还有 ${pending.length} 项待选定` : '完成合并'}
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  )
}

export function CollabToolbarButton({ session }: { session: MergeSession | null }) {
  const dispatchOpen = () => window.dispatchEvent(new CustomEvent(OPEN_COLLAB_EVENT))
  return (
    <IconButton onClick={dispatchOpen} aria-label="双标签页协作合并">
      <Box className="collab-badge-wrap">
        <PeopleAlt />
        {session && <span className="collab-badge-dot" />}
      </Box>
    </IconButton>
  )
}

export function CollabControls({ store }: { store: Store }) {
  const [joinOpen, setJoinOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [joinError, setJoinError] = useState('')
  const [mergeError, setMergeError] = useState('')
  const { collab } = store
  const session = collab.activeSession
  const otherPeers = collab.peers.filter((peer) => peer.id !== collab.peerId)

  useEffect(() => {
    const onOpen = () => (collab.joined ? setMergeOpen(true) : setJoinOpen(true))
    window.addEventListener(OPEN_COLLAB_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_COLLAB_EVENT, onOpen)
  }, [collab.joined])

  const handleJoin = (role: 'script' | 'review') => {
    if (store.joinCollab(role)) {
      setJoinOpen(false)
      setJoinError('')
    } else {
      setJoinError(`另一个标签页已经以${role === 'script' ? '场记甲（场景/道具/服装）' : '场记乙（警告/回复）'}身份加入，请在那个标签页改选另一身份。`)
    }
  }

  const handleStartMerge = () => {
    const result = store.startMerge()
    if (result.ok) {
      setMergeError('')
      setMergeOpen(true)
    } else {
      setMergeError(result.reason ?? '无法开始合并')
    }
  }

  const handleReattach = (role: 'script' | 'review') => {
    if (store.reattachMerge(role)) {
      setJoinOpen(false)
      setMergeOpen(true)
    } else {
      setJoinError('未决合并会话已失效或被对方放弃。')
    }
  }

  const recoverable = collab.recoverableMerge

  return (
    <>
      {mergeError && (
        <Alert severity="warning" className="collab-inline-alert" onClose={() => setMergeError('')}>{mergeError}</Alert>
      )}

      {recoverable && !collab.joined && (
        <Paper className="collab-banner recover" elevation={0}>
          <Stack direction={{ xs: 'column', md: 'row' }} gap={1} alignItems={{ md: 'center' }} justifyContent="space-between">
            <Box>
              <Typography fontWeight={750}>检测到一场未完成的合并（开始于 {new Date(recoverable.createdAt).toLocaleString('zh-CN')}）</Typography>
              <Typography variant="body2" color="text.secondary">
                待选定内容已随会话保存在本机，没有丢失。请选择你要顶替继续的身份打开合并。
              </Typography>
            </Box>
            <Stack direction="row" gap={1}>
              <Button size="small" variant="contained" color="primary" startIcon={<EditNote />} onClick={() => handleReattach('script')}>顶替场记甲继续</Button>
              <Button size="small" variant="contained" color="secondary" startIcon={<FactCheck />} onClick={() => handleReattach('review')}>顶替场记乙继续</Button>
            </Stack>
          </Stack>
        </Paper>
      )}

      {collab.joined && (
        <Paper className="collab-banner" elevation={0}>
          <Stack direction={{ xs: 'column', md: 'row' }} gap={1} alignItems={{ md: 'center' }} justifyContent="space-between">
            <Stack direction="row" gap={1.2} alignItems="center" flexWrap="wrap">
              <PeopleAlt fontSize="small" />
              <Typography fontWeight={750}>
                当前身份：{collab.role === 'script' ? '场记甲 · 负责场景 / 道具 / 服装' : '场记乙 · 负责警告 / 回复'}
              </Typography>
              <Chip size="small" variant="outlined" label={collab.canEditScript ? '可编辑剧本' : '剧本只读'} />
              <Chip size="small" variant="outlined" label={collab.canReview ? '可处理审阅' : '审阅只读'} />
              {otherPeers.length === 0
                ? <Chip size="small" color="warning" label="等待另一个标签页加入…" />
                : otherPeers.map((peer) => (
                  <Chip key={peer.id} size="small" color="success" label={`对方在线：${peer.label}`} />
                ))}
            </Stack>
            <Stack direction="row" gap={1}>
              {session ? (
                <Button size="small" color="warning" variant="contained" startIcon={<FactCheck />} onClick={() => setMergeOpen(true)}>
                  继续合并（{unresolvedConflicts(session.conflicts).length} 项待选定）
                </Button>
              ) : (
                <Button size="small" variant="contained" startIcon={<CallMerge />} disabled={otherPeers.length === 0} onClick={handleStartMerge}>
                  断网恢复 · 开始合并
                </Button>
              )}
              <Button size="small" color="inherit" onClick={store.leaveCollab}>退出协作</Button>
            </Stack>
          </Stack>
        </Paper>
      )}

      {!collab.joined && !recoverable && (
        <Paper className="collab-banner idle" elevation={0}>
          <Stack direction={{ xs: 'column', md: 'row' }} gap={1} alignItems={{ md: 'center' }} justifyContent="space-between">
            <Typography variant="body2" color="text.secondary">
              两名场记在两个标签页同时改同一剧本：甲整理场景/道具/服装，乙处理警告/回复，断网恢复后按字段所有权三方合并。
            </Typography>
            <Button size="small" variant="outlined" startIcon={<PeopleAlt />} onClick={() => setJoinOpen(true)}>开始协作</Button>
          </Stack>
        </Paper>
      )}

      <Dialog open={joinOpen} onClose={() => setJoinOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>开始双标签页协作</DialogTitle>
        <DialogContent>
          <Typography color="text.secondary" mb={2}>
            在两个浏览器标签页打开本工具，分别选择身份。共同原稿会在第一个标签页加入时冻结；断网恢复后通过“开始合并”按字段所有权合并。
          </Typography>
          {joinError && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setJoinError('')}>{joinError}</Alert>}
          <Stack gap={1.5}>
            <Button variant="outlined" size="large" startIcon={<EditNote />} onClick={() => handleJoin('script')}>
              场记甲 · 整理场景和道具（含服装、角色）
            </Button>
            <Button variant="outlined" size="large" startIcon={<FactCheck />} onClick={() => handleJoin('review')}>
              场记乙 · 处理警告和回复
            </Button>
          </Stack>
        </DialogContent>
        <DialogActions><Button onClick={() => setJoinOpen(false)}>取消</Button></DialogActions>
      </Dialog>

      <MergeDialog store={store} open={mergeOpen} onClose={() => setMergeOpen(false)} />
    </>
  )
}
