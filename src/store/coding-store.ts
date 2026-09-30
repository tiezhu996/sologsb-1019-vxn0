import { createMemo, createSignal } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { seedState } from '../data/seed';
import type {
  CodingExport,
  CoderId,
  CodingOperation,
  CodingState,
  PendingCommit,
  PersistedEnvelope,
  RemoteHead,
  Segment,
  Theme
} from '../types';
import { applyOperation, dryRunConflicts } from './operations';
import { applyPending, deleteManyPending, putPending, readAllPending, readEnvelope } from '../utils/db';
import {
  liveWriters,
  mirrorAllPending,
  mirrorDeletePending,
  mirrorEnvelope,
  mirrorPatchPending,
  mirrorPutPending,
  readMirrorEnvelope,
  touchHeartbeat
} from '../utils/local-mirror';

const TAB_ID = crypto.randomUUID();
const BACKOFF_BASE_MS = 800;
const BACKOFF_MAX_MS = 15000;

// ---- 提交队列：保证“先落待提交记录，再写快照”且严格串行 ----
let initResolve: () => void = () => undefined;
const initGate = new Promise<void>((resolve) => {
  initResolve = resolve;
});
let queueTail: Promise<void> = initGate.then(() => undefined);

// ---- 已提交状态（与 IndexedDB 快照一致）与待提交记录 ----
const [committed, setCommitted] = createStore<CodingState>(seedState());
const [pending, setPending] = createSignal<PendingCommit[]>([]);
const [storageReady, setStorageReady] = createSignal(false);
const [writeError, setWriteErrorState] = createSignal<string | null>(null);
const setWriteError = (value: string | null) => setWriteErrorState(value);
const [remoteHead, setRemoteHead] = createSignal<RemoteHead | null>(null);
const [degraded, setDegraded] = createSignal(false);
const [lastSavedAt, setLastSavedAt] = createSignal<Date | null>(null);

// ---- 本标签视图偏好（不产生修订，不参与数据库快照） ----
const VIEW_PREFIX = 'sologsb-1019-view-v1';
const loadView = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(`${VIEW_PREFIX}:${key}`);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const saveView = (key: string, value: unknown) => {
  try {
    localStorage.setItem(`${VIEW_PREFIX}:${key}`, JSON.stringify(value));
  } catch {
    // 忽略
  }
};

// 乐观投影：已提交状态 + 所有待提交（含冲突保留）提交，界面永远显示研究者自己的完整工作
const [activeSegmentView, setActiveSegmentView] = createSignal(
  loadView('activeSegmentId', committed.activeSegmentId)
);
const [activeTranscriptView, setActiveTranscriptView] = createSignal(
  loadView('activeTranscriptId', committed.activeTranscriptId)
);
const [activeThemeView, setActiveThemeView] = createSignal(
  loadView('activeThemeId', committed.activeThemeId)
);

// 操作自身改变的激活项（新建/删除/拆分主题、导入转写、撤销重做）优先于本标签点击偏好
const operationOverrides = () => {
  const overrides: { segmentId?: string; transcriptId?: string; themeId?: string } = {};
  const list = pending();
  for (const commit of list) {
    const op = commit.operation;
    if (op.type === 'addTheme') overrides.themeId = op.id;
    if (op.type === 'splitTheme') overrides.themeId = op.newId;
    if (op.type === 'mergeThemes') overrides.themeId = op.targetId;
    if (op.type === 'importTranscript') {
      overrides.transcriptId = op.transcript.id;
      overrides.segmentId = op.segments[0]?.id;
    }
    if (op.type === 'restore') {
      overrides.segmentId = op.snapshot.activeSegmentId;
      overrides.transcriptId = op.snapshot.activeTranscriptId;
      overrides.themeId = op.snapshot.activeThemeId;
    }
  }
  return overrides;
};

const staged = createMemo<CodingState>(() => {
  let acc = committed;
  for (const commit of pending()) {
    acc = applyOperation(acc, commit.operation, {
      commitId: commit.id,
      at: commit.createdAt,
      action: commit.action,
      detail: commit.detail
    });
  }
  const overrides = operationOverrides();
  return {
    ...acc,
    activeSegmentId: overrides.segmentId ?? (activeSegmentView() || acc.activeSegmentId),
    activeTranscriptId: overrides.transcriptId ?? (activeTranscriptView() || acc.activeTranscriptId),
    activeThemeId: overrides.themeId ?? (activeThemeView() || acc.activeThemeId)
  };
});

const sortedPending = (commits: PendingCommit[]) =>
  [...commits].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

const syncPendingSignal = (commits: PendingCommit[]) => {
  setPending(reconcile(sortedPending(commits), { merge: false }));
};

const patchCommitInPlace = (id: string, patch: Partial<PendingCommit>) => {
  const next = pending().map((item) => (item.id === id ? { ...item, ...patch } : item));
  syncPendingSignal(next);
};

// 撤销/重做以“恢复整份视图状态”的形式走同一条提交管线
const [undoStack, setUndoStack] = createSignal<Array<Omit<CodingState, 'revision' | 'updatedAt' | 'headCommitId'>>>([]);
const [redoStack, setRedoStack] = createSignal<Array<Omit<CodingState, 'revision' | 'updatedAt' | 'headCommitId'>>>([]);

let channel: BroadcastChannel | null = null;
let heartbeatTimer: number | undefined;
let retryTimers = new Map<string, number>();

const postChannel = (message: unknown) => {
  try {
    channel?.postMessage(message);
  } catch {
    // 频道关闭时忽略
  }
};

const broadcastHead = (envelope: PersistedEnvelope) => {
  postChannel({ kind: 'head', revision: envelope.revision, updatedAt: envelope.updatedAt, writerId: TAB_ID });
};

const writerName = () => staged().coderA || `标签页 ${TAB_ID.slice(0, 4)}`;

const currentEnvelope = (state: CodingState): PersistedEnvelope => ({
  revision: state.revision,
  updatedAt: state.updatedAt,
  writerId: TAB_ID,
  state
});

// ---- 入队一次编码改动：待提交记录先落库（带基础修订），随后按记录写主题/片段/审计/冲突 ----
const enqueueCommit = (
  action: string,
  detail: string,
  operation: CodingOperation,
  options?: { skipHistory?: boolean; previousView?: Omit<CodingState, 'revision' | 'updatedAt' | 'headCommitId'> }
): void => {
  const baseRevision = committed.revision;
  const now = new Date().toISOString();
  const commit: PendingCommit = {
    id: `c-${crypto.randomUUID()}`,
    baseRevision,
    createdAt: now,
    writerId: TAB_ID,
    writerName: writerName(),
    action,
    detail,
    operation,
    status: 'pending',
    attempts: 0,
    lastError: null,
    conflict: null
  };

  if (!options?.skipHistory) {
    // 捕获本次入队前的完整乐观视图（可能包含更早但尚未落库的提交）
    setUndoStack((items) => [
      ...items.slice(-49),
      options?.previousView ?? stripHead(staged())
    ]);
    setRedoStack([]);
  }

  // 1) 先写待提交记录（localStorage 镜像同步落盘；IDB 由队列保证）
  mirrorPutPending(commit);
  syncPendingSignal([...pending(), commit]);
  setWriteError(null);

  // 2) 串行提交：读当前快照 → 应用操作（主题/片段判断/审计/冲突标记一起推进）→ 原子 CAS 写
  const run = queueTail.then(async () => {
    await processCommit(commit.id);
  });
  queueTail = run.catch(() => undefined);
};

const stripHead = (
  state: CodingState
): Omit<CodingState, 'revision' | 'updatedAt' | 'headCommitId'> => {
  const { revision: _r, updatedAt: _u, headCommitId: _h, ...rest } = state;
  return rest;
};

const processCommit = async (commitId: string): Promise<void> => {
  const commit = pending().find((item) => item.id === commitId);
  if (!commit) return;
  // 分叉提交只由研究者显式“重放到新版本”，不自动处理
  if (commit.status === 'conflicted') return;

  if (degraded()) {
    finalizeDegraded(commit);
    return;
  }

  try {
    const attempts = commit.attempts + 1;
    patchCommitInPlace(commit.id, { attempts });
    await putPending({ ...commit, attempts });

    const expectedRevision = committed.revision;
    const expectedHeadCommitId = committed.headCommitId;
    const nextState = applyOperation(committed, commit.operation, {
      commitId: commit.id,
      at: commit.createdAt,
      action: commit.action,
      detail: commit.detail
    });
    const envelope = currentEnvelope(nextState);
    const result = await applyPending({ commit, envelope, expectedRevision, expectedHeadCommitId });

    if (result.ok && result.envelope) {
      finishCommit(commit.id, result.envelope);
      return;
    }

    if (result.conflict) {
      // 另一个标签页已经推进修订：先收敛到对方版本，绝不覆盖对方内容，
      // 本标签全部未完成提交保留为分叉，由研究者逐项选择重放或放弃
      const remoteEnvelope = await readEnvelope();
      if (remoteEnvelope && convergeToRemote(remoteEnvelope)) {
        return;
      }
      // 读不到对方版本（瞬态），按失败重试
      scheduleRetry(commit.id, '检测到并发修订但暂时无法读取其他标签页版本');
      return;
    }

    throw new Error(commit.lastError ?? '本地快照写入失败');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scheduleRetry(commit.id, message);
  }
};

const finishCommit = (commitId: string, envelope: PersistedEnvelope) => {
  mirrorEnvelope(envelope);
  setCommitted(reconcile(envelope.state, { merge: false }));
  const remaining = mirrorDeletePending([commitId]);
  syncPendingSignal(remaining);
  retryTimers.get(commitId) && window.clearTimeout(retryTimers.get(commitId));
  retryTimers.delete(commitId);
  setWriteError(null);
  setLastSavedAt(new Date());
  setRemoteHead(null);
  broadcastHead(envelope);
};

const finalizeDegraded = (commit: PendingCommit) => {
  // IndexedDB 不可用：镜像即权威，直接在本地推进但记录保留，待数据库恢复后补提交
  const nextState = applyOperation(committed, commit.operation, {
    commitId: commit.id,
    at: commit.createdAt,
    action: commit.action,
    detail: commit.detail
  });
  const envelope = currentEnvelope(nextState);
  mirrorEnvelope(envelope);
  setCommitted(reconcile(envelope.state, { merge: false }));
  patchCommitInPlace(commit.id, { lastError: 'IndexedDB 不可用，记录保留在浏览器镜像中，恢复后自动补提交' });
  setLastSavedAt(new Date());
};

const scheduleRetry = (commitId: string, message: string) => {
  const existing = retryTimers.get(commitId);
  if (existing) window.clearTimeout(existing);
  const commit = pending().find((item) => item.id === commitId);
  const attempts = commit?.attempts ?? 1;
  patchCommitInPlace(commitId, { lastError: message });
  setWriteError(message);
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
  const timer = window.setTimeout(() => {
    retryTimers.delete(commitId);
    const run = queueTail.then(() => processCommit(commitId));
    queueTail = run.catch(() => undefined);
  }, delay);
  retryTimers.set(commitId, timer);
};

/** 研究者手动要求重试所有未完成提交 */
const retryAll = () => {
  pending().forEach((commit) => {
    if (retryTimers.has(commit.id)) return;
    if (commit.status === 'conflicted') rebaseCommit(commit.id);
    else {
      const run = queueTail.then(() => processCommit(commit.id));
      queueTail = run.catch(() => undefined);
    }
  });
};

/** 载入其他标签页版本后，把一条分叉提交重新基于当前修订提交 */
const rebaseCommit = (commitId: string) => {
  const updated = mirrorPatchPending(commitId, (item) => ({
    ...item,
    status: 'pending',
    baseRevision: committed.revision,
    conflict: null,
    lastError: null
  }));
  syncPendingSignal(updated);
  const run = queueTail.then(() => processCommit(commitId));
  queueTail = run.catch(() => undefined);
};

/** 放弃一条未完成提交（仅研究者显式操作） */
const discardCommit = (commitId: string) => {
  const remaining = mirrorDeletePending([commitId]);
  syncPendingSignal(remaining);
  const timer = retryTimers.get(commitId);
  if (timer) {
    window.clearTimeout(timer);
    retryTimers.delete(commitId);
  }
  void deleteManyPending([commitId]);
};

// ---- 收敛到其他标签页版本：不覆盖任何提交，只前移基础，分叉提交保留供逐项选择 ----
const convergeToRemote = (remoteEnvelope: PersistedEnvelope): boolean => {
  if (remoteEnvelope.revision <= committed.revision) return false;
  mirrorEnvelope(remoteEnvelope);
  setCommitted(reconcile(remoteEnvelope.state, { merge: false }));
  const updated = mirrorAllPending().map((item) =>
    item.writerId === TAB_ID && item.status === 'pending'
      ? {
          ...item,
          status: 'conflicted' as const,
          conflict: {
            detectedAt: new Date().toISOString(),
            currentRevision: remoteEnvelope.revision,
            reasons: dryRunConflicts(remoteEnvelope.state, item.operation, item.id, new Date().toISOString())
          }
        }
      : item
  );
  updated.forEach((item) => mirrorPutPending(item));
  syncPendingSignal(updated);
  setRemoteHead({
    revision: remoteEnvelope.revision,
    updatedAt: remoteEnvelope.updatedAt,
    writerId: remoteEnvelope.writerId
  });
  return true;
};

// ---- 载入其他标签页版本：不覆盖任何提交，只是把基础前移，分叉提交留待逐项选择 ----
const adoptRemote = async (): Promise<void> => {
  const run = queueTail.then(async () => {
    const remoteEnvelope = await readEnvelope();
    if (!remoteEnvelope) return;
    convergeToRemote(remoteEnvelope);
    setUndoStack([]);
    setRedoStack([]);
    setLastSavedAt(new Date());
  });
  queueTail = run.catch(() => undefined);
};

const resolveConflictMarker = (markerId: string) => {
  enqueueCommit('处理冲突标记', `标记冲突 ${markerId} 已复核`, { type: 'resolveConflict', markerId }, { skipHistory: true });
};

// ---- 启动：恢复未完成提交后才开放编辑 ----
const initialize = async (): Promise<void> => {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  touchHeartbeat(TAB_ID);

  let envelope = await readEnvelope();
  const idbAvailable = envelope !== null || ('indexedDB' in window);
  if (!envelope) envelope = readMirrorEnvelope();
  setDegraded(!idbAvailable);

  // 合并 IDB 与镜像中的待提交记录（浏览器崩溃时 IDB 可能少写了镜像里的记录）
  const idbPending = await readAllPending();
  const byId = new Map<string, PendingCommit>();
  [...mirrorAllPending(), ...idbPending].forEach((commit) => {
    const existing = byId.get(commit.id);
    if (!existing || commit.attempts > existing.attempts) byId.set(commit.id, commit);
  });

  const live = new Set(liveWriters());
  // 只自动恢复“已死标签页”或本标签页遗留的记录；存活标签自己会处理
  const mineOrDead = [...byId.values()].filter(
    (commit) => commit.writerId === TAB_ID || !live.has(commit.writerId)
  );
  const foreignLive = [...byId.values()].filter(
    (commit) => commit.writerId !== TAB_ID && live.has(commit.writerId)
  );

  if (!envelope) {
    // 首次使用：以种子状态建立基线快照
    const state = committed;
    envelope = { revision: state.revision, updatedAt: state.updatedAt, writerId: TAB_ID, state };
    mirrorEnvelope(envelope);
  }

  const appliedIds: string[] = [];
  const conflicted: PendingCommit[] = [];
  let cursor = envelope;
  for (const commit of sortedPending(mineOrDead)) {
    // 收敛过程中已被标记为分叉的后续记录，留给研究者逐项选择
    if (conflicted.some((item) => item.id === commit.id)) continue;
    // 已在初始快照审计里（崩溃发生在删除记录之后）：直接确认清除，不重复重放
    if (envelope.state.audit.some((entry) => entry.id === `a-${commit.id}`)) {
      appliedIds.push(commit.id);
      continue;
    }
    const nextState = applyOperation(cursor.state, commit.operation, {
      commitId: commit.id,
      at: commit.createdAt,
      action: commit.action,
      detail: commit.detail
    });
    const nextEnvelope: PersistedEnvelope = {
      revision: nextState.revision,
      updatedAt: nextState.updatedAt,
      writerId: TAB_ID,
      state: nextState
    };
    if (idbAvailable) {
      const result = await applyPending({
        commit,
        envelope: nextEnvelope,
        expectedRevision: cursor.revision,
        expectedHeadCommitId: cursor.state.headCommitId
      });
      if (result.ok && result.envelope) {
        cursor = result.envelope;
        mirrorEnvelope(cursor);
        appliedIds.push(commit.id);
        continue;
      }
      if (result.conflict) {
        // 其他存活标签已经推进：收敛到对方版本，保留该记录为分叉
        const remoteEnvelope = await readEnvelope();
        if (remoteEnvelope) {
          convergeToRemote(remoteEnvelope);
          cursor = remoteEnvelope;
        }
        conflicted.push({
          ...commit,
          status: 'conflicted',
          conflict: {
            detectedAt: new Date().toISOString(),
            currentRevision: cursor.revision,
            reasons: dryRunConflicts(cursor.state, commit.operation, commit.id, new Date().toISOString())
          }
        });
        continue;
      }
      // 存储层瞬态失败：保留为待重试
      conflicted.push({ ...commit, lastError: commit.lastError ?? '恢复时写入失败，等待重试' });
      continue;
    }
    // 降级模式：镜像即权威
    cursor = nextEnvelope;
    mirrorEnvelope(cursor);
    appliedIds.push(commit.id);
  }

  if (appliedIds.length) mirrorDeletePending(appliedIds);
  if (conflicted.length) conflicted.forEach((commit) => mirrorPutPending(commit));

  setCommitted(reconcile(cursor.state, { merge: false }));
  const appliedSet = new Set(appliedIds);
  const conflictedMap = new Map(conflicted.map((commit) => [commit.id, commit]));
  const leftovers = sortedPending([
    ...[...byId.values()].filter((commit) => !appliedSet.has(commit.id)).map((commit) => conflictedMap.get(commit.id) ?? commit),
    ...foreignLive.filter((commit) => !byId.has(commit.id))
  ]);
  syncPendingSignal(leftovers);
  setLastSavedAt(new Date());

  setStorageReady(true);
  initResolve();

  // 恢复后仍有本标签未完成记录（写入失败遗留），重新排队
  queueTail = queueTail.then(async () => {
    for (const commit of pending()) {
      if (commit.writerId === TAB_ID && commit.status === 'pending') await processCommit(commit.id);
    }
  });

  heartbeatTimer = window.setInterval(() => {
    touchHeartbeat(TAB_ID);
    if (degraded() && 'indexedDB' in window) {
      // 数据库恢复后补提交
      setDegraded(false);
      retryAll();
    }
  }, 2500);

  window.addEventListener('online', retryAll);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void reconcileWithDatabase();
  });

  if ('BroadcastChannel' in window) {
    channel = new BroadcastChannel('sologsb-1019-coding');
    channel.onmessage = async (event: MessageEvent) => {
      const data = event.data as { kind?: string; writerId?: string } | undefined;
      if (!data || data.writerId === TAB_ID) return;
      if (data.kind === 'hello') {
        const latest = await readEnvelope();
        if (latest) postChannel({ kind: 'head', revision: latest.revision, updatedAt: latest.updatedAt, writerId: TAB_ID });
        return;
      }
      if (data.kind === 'head') {
        const head = data as unknown as RemoteHead & { kind: string };
        if (head.revision <= committed.revision) return;
        const remoteEnvelope = await readEnvelope();
        if (!remoteEnvelope || remoteEnvelope.revision !== head.revision) {
          // 快照尚未读到对应修订，先记录对方头部，稍后由可见性/下一条消息再核对
          setRemoteHead({ revision: head.revision, updatedAt: head.updatedAt, writerId: head.writerId });
          return;
        }
        // 无论本页有没有未完成提交都先跟上对方基础；
        // convergeToRemote 会把本页 pending 提交保留为分叉，不覆盖对方内容
        convergeToRemote(remoteEnvelope);
        if (!pending().some((commit) => commit.writerId === TAB_ID)) setRemoteHead(null);
      }
    };
    postChannel({ kind: 'hello', writerId: TAB_ID });
  }
};

/** 标签重新可见时主动核对数据库，发现对方更新时保留分叉提交 */
const reconcileWithDatabase = async (): Promise<void> => {
  if (degraded()) return;
  const remoteEnvelope = await readEnvelope();
  if (!remoteEnvelope) return;
  convergeToRemote(remoteEnvelope);
};

// ---- 视图选择（不产生修订，只存本标签偏好） ----

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

export function useCodingStore() {
  // ---- 撤销 / 重做也通过待提交记录落库，崩溃后仍可恢复到正确版本 ----
  const undo = () => {
    const items = undoStack();
    if (!items.length) return;
    const previous = items[items.length - 1];
    setUndoStack(items.slice(0, -1));
    setRedoStack((redo) => [...redo, stripHead(staged())]);
    enqueueCommit('撤销编码', '恢复到上一个编码版本', { type: 'restore', snapshot: previous }, { skipHistory: true });
  };

  const redo = () => {
    const items = redoStack();
    if (!items.length) return;
    const next = items[items.length - 1];
    setRedoStack(items.slice(0, -1));
    setUndoStack((undoItems) => [...undoItems, stripHead(staged())]);
    enqueueCommit('重做编码', '重新应用被撤销的版本', { type: 'restore', snapshot: next }, { skipHistory: true });
  };

  const selectSegment = (id: string) => {
    setActiveSegmentView(id);
    saveView('activeSegmentId', id);
  };
  const selectTranscript = (id: string) => {
    setActiveTranscriptView(id);
    saveView('activeTranscriptId', id);
  };
  const selectTheme = (id: string) => {
    setActiveThemeView(id);
    saveView('activeThemeId', id);
  };

  const setCoder = (coder: CoderId, name: string) => {
    enqueueCommit('修改编码者', `${coder === 'A' ? '编码者 A' : '编码者 B'}：${name}`, { type: 'setCoder', coder, name }, { skipHistory: true });
  };

  const toggleAssignment = (segmentId: string, coder: CoderId, themeId: string, enabled: boolean) => {
    const names = staged();
    enqueueCommit('调整编码', `${coder === 'A' ? names.coderA : names.coderB} ${enabled ? '添加' : '移除'}主题`, {
      type: 'toggleAssignment',
      segmentId,
      coder,
      themeId,
      enabled
    });
  };

  const batchAssign = (segmentIds: string[], coder: CoderId, themeId: string) => {
    if (!segmentIds.length) return;
    enqueueCommit('批量重编码', `将 ${segmentIds.length} 个片段分配给主题`, { type: 'batchAssign', segmentIds, coder, themeId });
  };

  const addTheme = (name: string, parentId: string | null) => {
    const id = `t-${crypto.randomUUID()}`;
    enqueueCommit('新建主题', name, { type: 'addTheme', id, name, parentId, color: parentId ? '#57978c' : '#267365' });
    return id;
  };

  const updateTheme = (themeId: string, patch: Partial<Theme>, fieldLabel: string) => {
    enqueueCommit('编辑主题', fieldLabel, { type: 'updateTheme', themeId, patch });
  };

  const deleteTheme = (themeId: string) => {
    const view = staged();
    const theme = view.themes.find((item) => item.id === themeId);
    if (!theme) return;
    enqueueCommit('删除主题', theme.name, { type: 'deleteTheme', themeId });
  };

  const mergeThemes = (sourceId: string, targetId: string) => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const view = staged();
    enqueueCommit(
      '合并主题',
      `${view.themes.find((item) => item.id === sourceId)?.name ?? sourceId} → ${view.themes.find((item) => item.id === targetId)?.name ?? targetId}`,
      { type: 'mergeThemes', sourceId, targetId }
    );
  };

  const splitTheme = (sourceId: string, newName: string, segmentIds: string[]) => {
    const newId = `t-${crypto.randomUUID()}`;
    enqueueCommit('拆分主题', newName, { type: 'splitTheme', sourceId, newId, newName, segmentIds });
    return newId;
  };

  const updateSegment = (segmentId: string, patch: Pick<Segment, 'speaker' | 'time' | 'text' | 'note'>) => {
    enqueueCommit('编辑片段', `片段 ${segmentId}`, { type: 'updateSegment', segmentId, patch });
  };

  const importTranscript = (raw: string, title: string, participant: string, sourceName: string) => {
    const transcriptId = `tr-${crypto.randomUUID()}`;
    const rows = parseTranscript(raw, participant);
    const start = staged().segments.length;
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
    enqueueCommit('导入转写', `${title}（${rows.length} 个片段）`, {
      type: 'importTranscript',
      transcript: { id: transcriptId, title, participant, importedAt: new Date().toISOString(), sourceName },
      segments
    });
  };

  const addExample = (themeId: string, example: string) => {
    const trimmed = example.trim();
    if (!trimmed) return;
    enqueueCommit('添加主题示例', trimmed, { type: 'addExample', themeId, example: trimmed });
  };

  const orderedThemes = () => buildTreeOrder(staged().themes);

  // ---- 导出：显示最终修订与所有未完成提交 ----
  const buildExport = (): CodingExport => {
    const view = staged();
    return {
      ...structuredClone(view),
      exportedAt: new Date().toISOString(),
      finalRevision: view.revision,
      pendingCommits: pending().map((commit) => ({
        id: commit.id,
        baseRevision: commit.baseRevision,
        createdAt: commit.createdAt,
        writerName: commit.writerName,
        action: commit.action,
        detail: commit.detail,
        status: commit.status,
        attempts: commit.attempts,
        lastError: commit.lastError,
        conflict: commit.conflict
      })),
      unresolvedConflicts: view.conflicts.filter((marker) => !marker.resolved)
    };
  };

  const exportCoding = (format: 'json' | 'csv') => {
    const view = staged();
    if (format === 'json') return JSON.stringify(buildExport(), null, 2);
    const segmentMap = new Map(view.segments.map((segment) => [segment.id, segment]));
    const themeMap = new Map(view.themes.map((theme) => [theme.id, theme]));
    const escape = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const rows = [['片段编号', '时间', '发言人', '原文', '编码者', '主题路径', '备忘录'].map(escape).join(',')];
    view.segments.forEach((segment) => {
      (['A', 'B'] as CoderId[]).forEach((coder) => {
        const name = coder === 'A' ? view.coderA : view.coderB;
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
        rows.push([segment.id, segment.time, segment.speaker, segment.text, name, paths.join(' | '), segmentMap.get(segment.id)?.note ?? ''].map(escape).join(','));
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

  const pendingCommits = pending;
  const conflictedCommits = createMemo(() => pending().filter((commit) => commit.status === 'conflicted'));
  const unresolvedMarkers = createMemo(() => staged().conflicts.filter((marker) => !marker.resolved));
  const hasDivergence = createMemo(() => conflictedCommits().length > 0 || (remoteHead() !== null && pending().some((commit) => commit.writerId === TAB_ID)));

  return {
    get state(): CodingState {
      return staged();
    },
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
    // 待提交记录 / 冲突 / 恢复
    pendingCommits,
    conflictedCommits,
    unresolvedMarkers,
    hasDivergence,
    remoteHead,
    writeError,
    degraded,
    storageReady,
    lastSavedAt,
    retryAll,
    rebaseCommit,
    discardCommit,
    adoptRemote,
    resolveConflictMarker
  };
}
