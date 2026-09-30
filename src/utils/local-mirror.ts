import type { PendingCommit, PersistedEnvelope } from '../types';

/**
 * IndexedDB 是权威存储；localStorage 只作为镜像：
 * - IDB 不可用时的降级读写
 * - 浏览器在 IDB 事务中途崩溃后的二级恢复来源
 * - 标签页心跳（用于启动时区分已死标签与存活标签的待提交记录）
 */
const MIRROR_KEY = 'sologsb-1019-state-v2';
const HEARTBEAT_TTL_MS = 6000;

interface Mirror {
  envelope: PersistedEnvelope | null;
  pending: Record<string, PendingCommit>;
  writers: Record<string, number>;
}

const emptyMirror = (): Mirror => ({ envelope: null, pending: {}, writers: {} });

const readMirror = (): Mirror => {
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    if (!raw) return emptyMirror();
    const parsed = JSON.parse(raw) as Partial<Mirror>;
    return { envelope: parsed.envelope ?? null, pending: parsed.pending ?? {}, writers: parsed.writers ?? {} };
  } catch {
    return emptyMirror();
  }
};

const writeMirror = (patch: (mirror: Mirror) => void): Mirror => {
  const mirror = readMirror();
  patch(mirror);
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(mirror));
  } catch {
    // 配额或隐私模式：镜像写不进不影响 IndexedDB 主路径
  }
  return mirror;
};

export const mirrorEnvelope = (envelope: PersistedEnvelope | null): PersistedEnvelope | null => {
  const mirror = writeMirror((item) => {
    item.envelope = envelope;
  });
  return mirror.envelope;
};

export const readMirrorEnvelope = (): PersistedEnvelope | null => readMirror().envelope;

export const mirrorPutPending = (commit: PendingCommit): PendingCommit[] => {
  const mirror = writeMirror((item) => {
    item.pending[commit.id] = commit;
  });
  return Object.values(mirror.pending);
};

export const mirrorPatchPending = (id: string, patch: (commit: PendingCommit) => PendingCommit): PendingCommit[] => {
  const mirror = writeMirror((item) => {
    const current = item.pending[id];
    if (current) item.pending[id] = patch(current);
  });
  return Object.values(mirror.pending);
};

export const mirrorDeletePending = (ids: string[]): PendingCommit[] => {
  const mirror = writeMirror((item) => {
    ids.forEach((id) => delete item.pending[id]);
  });
  return Object.values(mirror.pending);
};

export const mirrorAllPending = (): PendingCommit[] => Object.values(readMirror().pending);

/** 心跳：返回当前仍存活的其他 writerId 列表 */
export const touchHeartbeat = (writerId: string): string[] => {
  const now = Date.now();
  const mirror = writeMirror((item) => {
    item.writers[writerId] = now;
    Object.keys(item.writers).forEach((id) => {
      if (id !== writerId && now - item.writers[id] > HEARTBEAT_TTL_MS) delete item.writers[id];
    });
  });
  return Object.keys(mirror.writers).filter((id) => id !== writerId);
};

export const liveWriters = (): string[] => {
  const now = Date.now();
  return Object.entries(readMirror().writers)
    .filter(([, at]) => now - at <= HEARTBEAT_TTL_MS)
    .map(([id]) => id);
};
