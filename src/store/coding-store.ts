import { createSignal } from 'solid-js';
import { createStore, reconcile, unwrap } from 'solid-js/store';
import { seedState } from '../data/seed';
import type {
  CoderId,
  CodingState,
  CommitChange,
  PendingCommit,
  PersistedEnvelope,
  Segment,
  Theme
} from '../types';
import {
  LEGACY_STATE_KEY,
  MIRROR_STATE_KEY,
  commitPending,
  deletePending,
  getAllPending,
  putPending,
  readEnvelope,
  storageMode,
  writeEnvelope
} from '../utils/db';
import { affectedEntities, applyCommit, canReapply, invertChange } from './engine';

const TAB_ID = crypto.randomUUID();
const TAB_LABEL = `标签页 ${TAB_ID.slice(0, 4)}`;
const CHANNEL_NAME = 'sologsb-1019-coding';

const cloneState = (state: CodingState): CodingState => structuredClone(unwrap(state));

const [state, setState] = createStore<CodingState>(seedState());
const [pending, setPending] = createSignal<PendingCommit[]>([]);
const [undoStack, setUndoStack] = createSignal<Array<{ change: CommitChange; action: string; detail: string }>>([]);
const [redoStack, setRedoStack] = createSignal<Array<{ change: CommitChange; action: string; detail: string }>>([]);
const [storageReady, setStorageReady] = createSignal(false);
const [lastSavedAt, setLastSavedAt] = createSignal<Date | null>(null);
const [saveError, setSaveError] = createSignal<string | null>(null);

let channel: BroadcastChannel | null = null;
let hydrated = false;
let draining = false;
let drainRequested = false;
/** 最近一次已知的权威 head 状态（乐观投影的基准；不包含未提交改动） */
let headState: CodingState | null = null;
/** 提交成功回调表（不入库；记录被放弃或失败时不会触发，保证撤销栈只在真正提交后移动） */
const committedCallbacks = new Map<string, () => void>();
/** durable 串行链：保证记录按入队顺序落盘，杜绝并发写乱序 */
let durableChain: Promise<void> = Promise.resolve();

/* ------------------------------------------------------------------ */
/* 待提交记录（outbox）信号维护                                           */
/* ------------------------------------------------------------------ */

const patchRecord = (id: string, patch: Partial<PendingCommit>) => {
  setPending((list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)));
};

const queuedAhead = () => pending().filter((item) => item.status === 'queued').length;

/* ------------------------------------------------------------------ */
/* 串行提交队列                                                          */
/* ------------------------------------------------------------------ */

type AttemptOutcome = 'committed' | 'conflicted' | 'error';

const postNotice = (message: { type: 'committed'; revision: number; commitId: string }) => {
  channel?.postMessage({ ...message, writerId: TAB_ID, at: new Date().toISOString() });
};

const mirrorLocalStorage = (envelope: PersistedEnvelope) => {
  // 仅在提交成功后刷新浏览级快照镜像；它永远落后或等于 IndexedDB，不会反过来覆盖
  try {
    localStorage.setItem(MIRROR_STATE_KEY, JSON.stringify(envelope.state));
  } catch {
    /* 配额等问题不影响主存储 */
  }
};

/** 把冲突结果同步回 IndexedDB（best-effort，失败也不影响保留语义） */
const persistRecordQuietly = async (record: PendingCommit) => {
  try {
    await putPending(record);
  } catch (error) {
    console.warn('待提交记录状态更新失败', error);
  }
};

/** 刷新到远端 head，并把在途记录逐条标记冲突（绝不覆盖对方内容） */
const refreshFromHead = async (envelope: PersistedEnvelope, reason: string): Promise<'advanced' | 'current'> => {
  if (envelope.revision <= (headState?.revision ?? state.revision)) return 'current';
  headState = structuredClone(unwrap(envelope.state));
  // 修订树已被对方推进：本页所有在途记录都保留给研究者逐项选择，
  // 不自动重放、不静默覆盖任一方内容。
  for (const record of pending().filter((item) => item.status === 'queued')) {
    const updated: PendingCommit = {
      ...record,
      status: 'conflicted',
      headRevision: envelope.revision,
      lastError: reason
    };
    patchRecord(record.id, { status: 'conflicted', headRevision: envelope.revision, lastError: reason });
    await persistRecordQuietly(updated);
  }
  // 显示回滚到权威 head；本页乐观改动随其冲突记录保留，逐项重放后会重新生效，不丢内容
  setState(reconcile(envelope.state, { merge: false }));
  // 旧撤销栈的反向记录基于旧修订树，继续撤销可能回退对方的改动，清空以免误伤（审计记录仍完整保留）
  setUndoStack([]);
  setRedoStack([]);
  return 'advanced';
};

/**
 * 在给定基础状态上应用记录，得到新状态（纯函数，乐观显示与权威提交共用同一结果）。
 * 乐观队列里第 n 条记录的基础 = 权威 head 依次应用前 n-1 条后的状态。
 */
const projectRecord = (base: CodingState, record: PendingCommit): CodingState => {
  const next = structuredClone(unwrap(base));
  // 活动选择属于本标签页视图：基础状态里可能指向旧对象，应用变更后再恢复，
  // 避免「新建主题后、提交完成的瞬间选中态闪丢」
  const activeThemeId = next.activeThemeId;
  const activeTranscriptId = next.activeTranscriptId;
  const activeSegmentId = next.activeSegmentId;
  applyCommit(next, record.change, record.action, record.detail, record.createdAt);
  if (record.change.kind !== 'add-theme' && record.change.kind !== 'import-transcript' &&
      record.change.kind !== 'merge-themes' && record.change.kind !== 'split-theme' &&
      record.change.kind !== 'delete-transcript') {
    next.activeThemeId = activeThemeId;
    next.activeTranscriptId = activeTranscriptId;
    next.activeSegmentId = activeSegmentId;
  }
  next.revision = record.baseRevision + 1;
  next.updatedAt = record.createdAt;
  return next;
};

/** 把当前全部 queued 记录按顺序投影到权威 head 上，得到应显示的乐观状态 */
const reproject = (head?: CodingState) => {
  const queued = pending().filter((item) => item.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!queued.length && head) {
    setState(reconcile(head, { merge: false }));
    return;
  }
  let projected: CodingState = head ? structuredClone(unwrap(head)) : (headState ?? cloneState(state));
  let changed = false;
  queued.forEach((record) => {
    if (record.baseRevision === projected.revision) {
      projected = projectRecord(projected, record);
      changed = true;
    }
  });
  if (changed || head) setState(reconcile(projected, { merge: false }));
};

/** 记录 durable 后立刻把改动应用到内存状态（乐观更新）；真正的权威写入由队列完成 */
const applyOptimistic = (record: PendingCommit) => {
  const next = projectRecord(cloneState(state), record);
  setState(reconcile(next, { merge: false }));
};

const attemptCommit = async (record: PendingCommit): Promise<AttemptOutcome> => {
  const now = new Date().toISOString();
  const marked: PendingCommit = { ...record, attemptedAt: now, attempts: record.attempts + 1 };
  patchRecord(record.id, { attemptedAt: now, attempts: marked.attempts });
  await persistRecordQuietly(marked);

  // 权威信封 = 权威 head + 本条记录（其余在途记录在它之后）。
  // 乐观显示是同一条投影链，因此提交落库的内容与研究者所见严格一致。
  const base = headState ?? cloneState(state);
  const next = projectRecord(base, record);
  const envelope: PersistedEnvelope = {
    revision: next.revision,
    updatedAt: next.updatedAt,
    writerId: TAB_ID,
    state: next
  };

  try {
    const result = await commitPending(record, envelope);
    if (result.ok) {
      headState = next;
      // 显示状态 = 新 head 上继续投影剩余在途记录
      reproject(next);
      setPending((list) => list.filter((item) => item.id !== record.id));
      setLastSavedAt(new Date());
      setSaveError(null);
      mirrorLocalStorage(envelope);
      postNotice({ type: 'committed', revision: envelope.revision, commitId: record.id });
      committedCallbacks.get(record.id)?.();
      committedCallbacks.delete(record.id);
      return 'committed';
    }
    // 基础修订已被其他标签页推进：记录保留为冲突，状态快照旧，不覆盖对方
    const head = await readEnvelope();
    if (head) await refreshFromHead(head, '另一个标签页先写入了新修订');
    const conflictPatch: Partial<PendingCommit> = {
      status: 'conflicted',
      headRevision: result.headRevision >= 0 ? result.headRevision : head?.revision,
      lastError: '基础修订已变化，需研究者逐项选择重放或放弃'
    };
    patchRecord(record.id, conflictPatch);
    await persistRecordQuietly({ ...marked, ...conflictPatch } as PendingCommit);
    // 冲突转人工选择：原回调不再触发（撤销栈保持不动；重放会生成全新记录）
    committedCallbacks.delete(record.id);
    return 'conflicted';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 同链上排在失败记录之后的在途记录也无法继续提交，一并转入失败等待重试
    const failedOrder = pending().filter((item) => item.status === 'queued')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .findIndex((item) => item.id === record.id);
    if (failedOrder >= 0) {
      pending().filter((item) => item.status === 'queued')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(failedOrder)
        .forEach((item) => {
          const patch: Partial<PendingCommit> = item.id === record.id
            ? { status: 'error', lastError: message }
            : { status: 'error', lastError: '前一条记录写入失败，等待恢复后按序重试' };
          patchRecord(item.id, patch);
          void persistRecordQuietly({ ...item, ...patch } as PendingCommit);
        });
    } else {
      patchRecord(record.id, { status: 'error', lastError: message });
    }
    // 显示回滚到权威 head；未提交改动都保留在失败记录里，可重试
    if (headState) setState(reconcile(headState, { merge: false }));
    setSaveError(message);
    return 'error';
  }
};

const drain = async () => {
  if (draining || !hydrated) {
    drainRequested = true;
    return;
  }
  draining = true;
  try {
    for (;;) {
      const nextRecord = pending().find((item) => item.status === 'queued');
      if (!nextRecord) break;
      const outcome = await attemptCommit(nextRecord);
      if (outcome === 'error') break; // 持久化写入失败：停下保留记录，等待恢复后重试
    }
  } finally {
    draining = false;
    if (drainRequested) {
      drainRequested = false;
      void drain();
    }
  }
};

/* ------------------------------------------------------------------ */
/* 入队：先把「带基础修订的待提交记录」落盘，再写主题/片段/审计             */
/* ------------------------------------------------------------------ */

interface EnqueueInput {
  action: string;
  detail: string;
  change: CommitChange;
  /** 仅在真正提交成功后执行（撤销/重做栈移动放在这里，冲突时不会误弹栈） */
  onCommitted?: () => void;
}

const enqueueCommit = (input: EnqueueInput): string => {
  const commitId = `c-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  // 基础修订 = 权威 head（乐观显示的 state.revision）+ 在途记录数；
  // 这样连续编码时每条记录都指向前一条，形成本页自己的提交链
  const baseRevision = (headState?.revision ?? state.revision) + queuedAhead();
  const record: PendingCommit = {
    id: commitId,
    baseRevision,
    createdAt: now,
    writerId: TAB_ID,
    writerLabel: TAB_LABEL,
    action: input.action,
    detail: input.detail,
    change: input.change,
    status: 'queued',
    attemptedAt: now,
    attempts: 0,
    persisted: false
  };
  setPending((list) => [...list, record]);
  if (input.onCommitted) committedCallbacks.set(commitId, input.onCommitted);
  // 串行 durable：前一条落盘完成后再落本条，保证 outbox 内顺序与入队一致
  durableChain = durableChain
    .then(() => putPending(record))
    .then(() => {
      patchRecord(commitId, { persisted: true });
      // 记录已安全落盘：立刻乐观显示，权威提交由队列原子完成
      applyOptimistic(record);
      void drain();
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      patchRecord(commitId, { status: 'error', lastError: `待提交记录无法写入本地数据库：${message}` });
      setSaveError(message);
    });
  return commitId;
};

/* ------------------------------------------------------------------ */
/* 树排序与转写解析（纯函数，保持原状）                                    */
/* ------------------------------------------------------------------ */

const buildTreeOrder = (themes: Theme[]) => {
  const children = new Map<string | null, Theme[]>();
  themes.forEach((theme) => children.set(theme.parentId, [...(children.get(theme.parentId) ?? []), theme]));
  const result: Theme[] = [];
  const visit = (parentId: string | null, depth: number) => {
    [...(children.get(parentId) ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).forEach((theme) => {
      result.push({ ...theme, name: `${'　'.repeat(depth)}${theme.name}` });
      visit(theme.id, depth + 1);
    });
  };
  visit(null, 0);
  return result;
};

const parseTranscript = (raw: string, speakerFallback: string): Array<Pick<Segment, 'time' | 'speaker' | 'text'>> => {
  const rows = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return rows.map((line, index) => {
    const timed = line.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*(?:[-—])?\s*([^:：]{1,24})[:：]\s*(.+)$/);
    if (timed) return { time: timed[1], speaker: timed[2].trim(), text: timed[3].trim() };
    return { time: `${String(Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 15).padStart(2, '0')}`, speaker: index % 2 === 0 ? speakerFallback : '访谈者', text: line };
  });
};

/* ------------------------------------------------------------------ */
/* 启动恢复                                                              */
/* ------------------------------------------------------------------ */

const readLegacyState = (): CodingState | null => {
  try {
    const raw = localStorage.getItem(LEGACY_STATE_KEY);
    return raw ? (JSON.parse(raw) as CodingState) : null;
  } catch {
    return null;
  }
};

const syncPendingFromDb = async () => {
  try {
    const remote = await getAllPending();
    setPending((local) => {
      const byId = new Map<string, PendingCommit>();
      // 库里的记录为基准（其他标签页留下的冲突记录也在这里可见）
      remote.forEach((item) => byId.set(item.id, { ...item, persisted: true }));
      local.forEach((item) => {
        const existing = byId.get(item.id);
        if (!existing) {
          // 库里没有：保留内存中的记录（落盘失败、尚未 durable）
          byId.set(item.id, item);
        } else if (item.persisted && item.attempts > existing.attempts) {
          // 同一记录本页正在提交、attempts 更新：以本页为准，避免并发同步把状态回退
          byId.set(item.id, item);
        }
        // 其余情况以库里的持久化记录为准
      });
      return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    });
  } catch (error) {
    console.warn('读取待提交记录失败', error);
  }
};

export function useCodingStore() {
  const initialize = async () => {
    // 等一帧，避免与首屏渲染争用
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    try {
      let envelope = await readEnvelope();
      const legacy = readLegacyState();
      if (!envelope) {
        // 全新安装或 v1→v2 首次迁移：v1 的浏览级快照在没有权威快照时作为起点
        const base = legacy ?? seedState();
        envelope = {
          revision: base.revision,
          updatedAt: base.updatedAt,
          writerId: legacy ? 'legacy-v1' : 'seed',
          state: base
        };
        await writeEnvelope(envelope);
      } else if (legacy && (legacy.revision > envelope.revision ||
        (legacy.revision === envelope.revision && legacy.updatedAt > envelope.updatedAt))) {
        // 旧版本中浏览器可能只写下浏览级快照、IndexedDB 停在旧修订：
        // 迁移时以研究者最后看到的浏览级快照恢复，避免静默丢失那部分改动；原 IDB 修订记入审计
        const recovered: CodingState = {
          ...legacy,
          audit: [
            { id: `a-${crypto.randomUUID()}`, at: new Date().toISOString(), action: '恢复浏览级快照', detail: `本地数据库停在 r${envelope.revision}，从浏览级快照恢复到 r${legacy.revision}` },
            ...legacy.audit
          ].slice(0, 250)
        };
        envelope = {
          revision: recovered.revision,
          updatedAt: recovered.updatedAt,
          writerId: 'legacy-v1-recovered',
          state: recovered
        };
        await writeEnvelope(envelope);
      }
      setState(reconcile(envelope.state, { merge: false }));
      headState = structuredClone(unwrap(envelope.state));
      await syncPendingFromDb();

      // 崩溃恢复：重放在途记录。基础修订对得上则补上提交，对不上则保留为冲突供逐项处理。
      // 先按 head 重放一次乐观视图，让研究者立刻看到「已落盘待提交」的改动
      pending()
        .filter((item) => item.status !== 'conflicted')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .forEach((item) => patchRecord(item.id, { status: 'queued' }));
      reproject(headState);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      hydrated = true;
      setStorageReady(true);
      void drain();
    }

    const handleExternalChange = async () => {
      const head = await readEnvelope();
      if (head) await refreshFromHead(head, '另一个标签页写入了新修订');
      await syncPendingFromDb();
      void drain();
    };

    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = async (event: MessageEvent<{ type: string; revision?: number; writerId?: string }>) => {
        const notice = event.data;
        if (!notice || notice.writerId === TAB_ID) return;
        if (notice.type === 'committed' && typeof notice.revision === 'number') await handleExternalChange();
      };
    }
    // 降级模式通过 storage 事件感知；IndexedDB 模式也顺带刷新在途记录（best-effort）
    window.addEventListener('storage', (event) => {
      if (event.key && event.key.startsWith('sologsb-1019-')) void handleExternalChange();
    });
  };

  /* ---------------------------------------------------------------- */
  /* 撤销 / 重做（基于记录反向重放，而非整快照覆盖）                       */
  /* ---------------------------------------------------------------- */

  const undo = () => {
    const items = undoStack();
    if (!items.length) return;
    const top = items[items.length - 1];
    const inverse = invertChange(cloneState(state), top.change);
    // 栈的弹出也在提交成功后执行；若发生冲突，本页撤销栈原样保留，研究者选择后可重试
    enqueueCommit({
      action: `撤销：${top.action}`,
      detail: top.detail,
      change: inverse,
      onCommitted: () => {
        setUndoStack((current) => (current[current.length - 1] === top ? current.slice(0, -1) : current));
        setRedoStack((redo) => [...redo, top]);
      }
    });
  };

  const redo = () => {
    const items = redoStack();
    if (!items.length) return;
    const top = items[items.length - 1];
    enqueueCommit({
      action: `重做：${top.action}`,
      detail: top.detail,
      change: structuredClone(top.change),
      onCommitted: () => {
        setRedoStack((current) => (current[current.length - 1] === top ? current.slice(0, -1) : current));
        setUndoStack((undoItems) => [...undoItems, top]);
      }
    });
  };

  /* ---------------------------------------------------------------- */
  /* 仅界面状态：选择不单独产生修订，随下一次编码提交一并落盘               */
  /* ---------------------------------------------------------------- */

  const selectSegment = (id: string) => setState('activeSegmentId', id);
  const selectTranscript = (id: string) => setState('activeTranscriptId', id);
  const selectTheme = (id: string) => setState('activeThemeId', id);

  const setCoder = (coder: CoderId, name: string) => {
    const before = coder === 'A' ? state.coderA : state.coderB;
    if (before === name) return;
    enqueueCommit({
      action: '修改编码者姓名',
      detail: `${before} → ${name}`,
      change: { kind: 'rename-coder', coder, before, after: name }
    });
  };

  /* ---------------------------------------------------------------- */
  /* 编码动作：每一个都先成为待提交记录                                    */
  /* ---------------------------------------------------------------- */

  const toggleAssignment = (segmentId: string, coder: CoderId, themeId: string, enabled: boolean) => {
    const segment = state.segments.find((item) => item.id === segmentId);
    if (!segment) return;
    const before = segment.assignments[coder].includes(themeId);
    if (before === enabled) return;
    const change: CommitChange = { kind: 'assignment', segmentId, coder, themeId, before, after: enabled };
    enqueueCommit({
      action: '调整编码',
      detail: `${coder === 'A' ? state.coderA : state.coderB} ${enabled ? '添加' : '移除'}主题`,
      change,
      onCommitted: () => setUndoStack((items) => [...items.slice(-49), { change, action: '调整编码', detail: '' }])
    });
  };

  const batchAssign = (segmentIds: string[], coder: CoderId, themeId: string) => {
    if (!segmentIds.length) return;
    const before: Record<string, boolean> = {};
    state.segments.forEach((segment) => {
      if (segmentIds.includes(segment.id)) before[segment.id] = segment.assignments[coder].includes(themeId);
    });
    const change: CommitChange = { kind: 'batch-assign', segmentIds: [...segmentIds], coder, themeId, before, after: true };
    enqueueCommit({
      action: '批量重编码',
      detail: `将 ${segmentIds.length} 个片段分配给主题`,
      change,
      onCommitted: () => setUndoStack((items) => [...items.slice(-49), { change, action: '批量重编码', detail: '' }])
    });
  };

  const addTheme = (name: string, parentId: string | null) => {
    const id = `t-${crypto.randomUUID()}`;
    const theme: Theme = { id, name, parentId, color: parentId ? '#57978c' : '#267365', definition: '', memo: '', examples: [] };
    const change: CommitChange = { kind: 'add-theme', theme };
    enqueueCommit({
      action: '新建主题',
      detail: name,
      change,
      onCommitted: () => setUndoStack((items) => [...items.slice(-49), { change, action: '新建主题', detail: name }])
    });
    return id;
  };

  const updateTheme = (themeId: string, patch: Partial<Theme>, fieldLabel: string) => {
    const theme = state.themes.find((item) => item.id === themeId);
    if (!theme) return;
    const before: Partial<Theme> = {};
    const after: Partial<Theme> = {};
    (Object.keys(patch) as Array<keyof Theme>).forEach((key) => {
      (before as Record<string, unknown>)[key] = structuredClone((theme as unknown as Record<string, unknown>)[key]);
      (after as Record<string, unknown>)[key] = structuredClone((patch as Record<string, unknown>)[key]);
    });
    const change: CommitChange = { kind: 'update-theme', themeId, before, after };
    enqueueCommit({
      action: '编辑主题',
      detail: fieldLabel,
      change,
      onCommitted: () => setUndoStack((items) => [...items.slice(-49), { change, action: '编辑主题', detail: fieldLabel }])
    });
  };

  const deleteTheme = (themeId: string) => {
    const theme = state.themes.find((item) => item.id === themeId);
    if (!theme) return;
    const assignments: Record<CoderId, Record<string, string[]>> = { A: {}, B: {} };
    state.segments.forEach((segment) => {
      (['A', 'B'] as CoderId[]).forEach((coder) => {
        if (segment.assignments[coder].includes(themeId)) assignments[coder][segment.id] = [...segment.assignments[coder]];
      });
    });
    const orphaned = state.themes.filter((item) => item.parentId === themeId).map((item) => ({ id: item.id, parentId: item.parentId }));
    const change: CommitChange = { kind: 'delete-theme', themeId, theme: structuredClone(theme), assignments, orphaned };
    enqueueCommit({
      action: '删除主题',
      detail: theme.name,
      change,
      onCommitted: () => setUndoStack((items) => [...items.slice(-49), { change, action: '删除主题', detail: theme.name }])
    });
  };

  const mergeThemes = (sourceId: string, targetId: string) => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const source = state.themes.find((item) => item.id === sourceId);
    if (!source) return;
    const assignmentsBefore: Record<CoderId, Record<string, string[]>> = { A: {}, B: {} };
    state.segments.forEach((segment) => {
      (['A', 'B'] as CoderId[]).forEach((coder) => {
        if (segment.assignments[coder].includes(sourceId)) assignmentsBefore[coder][segment.id] = [...segment.assignments[coder]];
      });
    });
    const reparented = state.themes.filter((theme) => theme.parentId === sourceId).map((theme) => theme.id);
    const change: CommitChange = {
      kind: 'merge-themes',
      sourceId,
      targetId,
      sourceTheme: structuredClone(source),
      reparented,
      assignmentsBefore
    };
    const detail = `${source.name} → ${state.themes.find((item) => item.id === targetId)?.name ?? targetId}`;
    enqueueCommit({
      action: '合并主题',
      detail,
      change,
      onCommitted: () => setUndoStack((items) => [...items.slice(-49), { change, action: '合并主题', detail }])
    });
  };

  const splitTheme = (sourceId: string, newName: string, segmentIds: string[]) => {
    const source = state.themes.find((theme) => theme.id === sourceId);
    if (!source) return `t-${crypto.randomUUID()}`;
    const newId = `t-${crypto.randomUUID()}`;
    const change: CommitChange = {
      kind: 'split-theme',
      sourceId,
      theme: { ...structuredClone(source), id: newId, name: newName, examples: [] },
      segmentIds: [...segmentIds]
    };
    enqueueCommit({
      action: '拆分主题',
      detail: newName,
      change,
      onCommitted: () => setUndoStack((items) => [...items.slice(-49), { change, action: '拆分主题', detail: newName }])
    });
    return newId;
  };

  const updateSegment = (segmentId: string, patch: Pick<Segment, 'speaker' | 'time' | 'text' | 'note'>) => {
    const segment = state.segments.find((item) => item.id === segmentId);
    if (!segment) return;
    const before: Pick<Segment, 'speaker' | 'time' | 'text' | 'note'> = {
      speaker: segment.speaker,
      time: segment.time,
      text: segment.text,
      note: segment.note
    };
    const change: CommitChange = { kind: 'update-segment', segmentId, before, after: { ...patch } };
    enqueueCommit({
      action: '编辑片段',
      detail: `片段 ${segmentId}`,
      change,
      onCommitted: () => setUndoStack((items) => [...items.slice(-49), { change, action: '编辑片段', detail: `片段 ${segmentId}` }])
    });
  };

  const importTranscript = (raw: string, title: string, participant: string, sourceName: string) => {
    const transcriptId = `tr-${crypto.randomUUID()}`;
    const rows = parseTranscript(raw, participant);
    const start = state.segments.length;
    const segments: Segment[] = rows.map((row, index) => ({
      id: `s-${crypto.randomUUID()}`,
      transcriptId,
      order: start + index,
      speaker: row.speaker,
      time: row.time,
      text: row.text,
      assignments: { A: [], B: [] },
      note: ''
    }));
    const change: CommitChange = {
      kind: 'import-transcript',
      transcript: { id: transcriptId, title, participant, importedAt: new Date().toISOString(), sourceName },
      segments
    };
    enqueueCommit({
      action: '导入转写',
      detail: `${title}（${rows.length} 个片段）`,
      change,
      onCommitted: () => setUndoStack((items) => [...items.slice(-49), { change, action: '导入转写', detail: title }])
    });
  };

  const addExample = (themeId: string, example: string) => {
    const trimmed = example.trim();
    const theme = state.themes.find((item) => item.id === themeId);
    if (!trimmed || !theme || theme.examples.includes(trimmed)) return;
    const change: CommitChange = { kind: 'add-example', themeId, example: trimmed };
    enqueueCommit({
      action: '添加主题示例',
      detail: trimmed,
      change,
      onCommitted: () => setUndoStack((items) => [...items.slice(-49), { change, action: '添加主题示例', detail: trimmed }])
    });
  };

  /* ---------------------------------------------------------------- */
  /* 失败恢复与冲突的逐项选择                                              */
  /* ---------------------------------------------------------------- */

  const retryCommit = async (commitId: string) => {
    const target = pending().find((item) => item.id === commitId);
    if (!target || target.status === 'queued') return;
    // 仅用于写入失败（error）的恢复；冲突（conflicted）必须由研究者逐项选择重放或放弃
    if (target.status !== 'error') return;
    // 同链恢复：按时间序，从被重试的记录起，之后仍处于 error 的本页记录一起重新排队
    const ordered = pending().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const start = ordered.findIndex((item) => item.id === commitId);
    const toReset = ordered.slice(start).filter((item) => item.status === 'error' && item.writerId === TAB_ID);
    try {
      for (const item of toReset) {
        const reset: PendingCommit = { ...item, status: 'queued', lastError: undefined };
        await putPending(reset);
        patchRecord(item.id, { status: 'queued', lastError: undefined, persisted: true });
      }
      setSaveError(null);
      reproject(headState ?? undefined);
      void drain();
    } catch (error) {
      patchRecord(commitId, { status: 'error', lastError: `待提交记录无法写入本地数据库：${error instanceof Error ? error.message : String(error)}` });
    }
  };

  const retryAll = () => {
    pending().filter((item) => item.status === 'error').forEach((item) => void retryCommit(item.id));
  };

  /** 在最新修订上重放：研究者显式选择后，以当前 head 为新基础生成一条新记录，不覆盖对方内容 */
  const reapplyCommit = (commitId: string) => {
    const record = pending().find((item) => item.id === commitId);
    if (!record || record.status === 'queued') return;
    if (!canReapply(cloneState(state), record.change)) {
      patchRecord(commitId, { lastError: '前提实体已不存在，无法在最新修订上重放，请放弃后手工重做' });
      return;
    }
    enqueueCommit({
      action: `重放提交：${record.action}`,
      detail: `原记录 ${commitId.slice(0, 8)} 基于 r${record.baseRevision}，研究者选择在 r${state.revision} 上重放`,
      change: structuredClone(record.change)
    });
    void (async () => {
      try {
        await deletePending(commitId);
      } catch (error) {
        console.warn('旧冲突记录删除失败，将继续保留', error);
        return; // 删除失败时保留旧记录，避免同一项看起来凭空消失
      }
      setPending((list) => list.filter((item) => item.id !== commitId));
    })();
  };

  /** 放弃未完成提交：从 outbox 移除，并写一条审计记录留痕 */
  const discardCommit = (commitId: string) => {
    const record = pending().find((item) => item.id === commitId);
    if (!record || record.status === 'queued') return;
    void (async () => {
      try {
        await deletePending(commitId);
        setPending((list) => list.filter((item) => item.id !== commitId));
      } catch (error) {
        patchRecord(commitId, { status: 'error', lastError: `删除失败：${error instanceof Error ? error.message : String(error)}` });
        return;
      }
      enqueueCommit({
        action: '放弃未完成提交',
        detail: `${record.action}（原记录 ${commitId.slice(0, 8)}，基础修订 r${record.baseRevision}）`,
        change: { kind: 'audit-only' }
      });
    })();
  };

  /* ---------------------------------------------------------------- */
  /* 导出                                                                */
  /* ---------------------------------------------------------------- */

  const exportCoding = (format: 'json' | 'csv') => {
    const themeMap = new Map(state.themes.map((theme) => [theme.id, theme]));
    if (format === 'json') {
      return JSON.stringify({
        exportedAt: new Date().toISOString(),
        finalRevision: state.revision,
        finalUpdatedAt: state.updatedAt,
        writerId: TAB_ID,
        storageMode: storageMode(),
        ...cloneState(state),
        pendingCommits: pending().map((record) => ({
          id: record.id,
          status: record.status,
          baseRevision: record.baseRevision,
          headRevision: record.headRevision,
          createdAt: record.createdAt,
          writerId: record.writerId,
          writerLabel: record.writerLabel,
          action: record.action,
          detail: record.detail,
          attempts: record.attempts,
          lastError: record.lastError,
          affected: affectedEntities(record.change)
        }))
      }, null, 2);
    }
    const escape = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const rows = [['片段编号', '时间', '发言人', '原文', '编码者', '主题路径', '备忘录'].map(escape).join(',')];
    state.segments.forEach((segment) => {
      (['A', 'B'] as CoderId[]).forEach((coder) => {
        const name = coder === 'A' ? state.coderA : state.coderB;
        const themeIds = segment.assignments[coder];
        const paths = themeIds.length ? themeIds.map((id) => {
          const names: string[] = [];
          let current = themeMap.get(id);
          while (current) {
            names.unshift(current.name);
            current = current.parentId ? themeMap.get(current.parentId) : undefined;
          }
          return names.join(' / ');
        }) : ['未编码'];
        rows.push([segment.id, segment.time, segment.speaker, segment.text, name, paths.join(' | '), segment.note].map(escape).join(','));
      });
    });
    return `﻿${rows.join('\n')}`;
  };

  const downloadExport = (format: 'json' | 'csv') => {
    const content = exportCoding(format);
    const blob = new Blob([content], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `访谈编码结果-${new Date().toISOString().slice(0, 10)}.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const orderedThemes = () => buildTreeOrder(state.themes);

  return {
    state,
    tabId: TAB_ID,
    initialize,
    undo,
    redo,
    canUndo: () => undoStack().length > 0,
    canRedo: () => redoStack().length > 0,
    selectSegment,
    selectTranscript,
    selectTheme,
    setCoder,
    toggleAssignment,
    batchAssign,
    addTheme,
    updateTheme,
    deleteTheme,
    mergeThemes,
    splitTheme,
    updateSegment,
    importTranscript,
    addExample,
    exportCoding,
    downloadExport,
    orderedThemes,
    // 未完成提交
    pendingCommits: pending,
    queuedCount: () => pending().filter((item) => item.status === 'queued').length,
    conflictedCount: () => pending().filter((item) => item.status === 'conflicted').length,
    errorCount: () => pending().filter((item) => item.status === 'error').length,
    affectedByCommits: (status: PendingCommit['status']) => {
      const themeIds = new Set<string>();
      const segmentIds = new Set<string>();
      pending().filter((item) => item.status === status).forEach((item) => {
        const affected = affectedEntities(item.change);
        affected.themeIds.forEach((id) => themeIds.add(id));
        affected.segmentIds.forEach((id) => segmentIds.add(id));
      });
      return { themeIds, segmentIds };
    },
    retryCommit,
    retryAll,
    reapplyCommit,
    discardCommit,
    /** 从本地数据库重新拉取未完成提交（storage 事件 / 手动恢复时使用） */
    refreshPending: syncPendingFromDb,
    /** 驱动提交队列（恢复在途记录时使用） */
    drainQueue: drain,
    saveError,
    storageReady,
    lastSavedAt,
    storageMode
  };
}
