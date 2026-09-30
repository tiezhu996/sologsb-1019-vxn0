import type { PendingCommit, PersistedEnvelope } from '../types';

const DB_NAME = 'sologsb-1019-coding';
const DB_VERSION = 2;
const STORE_SNAPSHOTS = 'snapshots';
const STORE_PENDING = 'pending-commits';
const SNAPSHOT_KEY = 'current';
const LS_ENVELOPE_KEY = 'sologsb-1019-envelope-v2';
const LS_PENDING_PREFIX = 'sologsb-1019-pending-v2:';

let dbPromise: Promise<IDBDatabase> | null = null;

export const idbAvailable = (): boolean =>
  typeof window !== 'undefined' && 'indexedDB' in window && !!window.indexedDB;

/* ------------------------------------------------------------------ */
/* IndexedDB 实现                                                       */
/* ------------------------------------------------------------------ */

const openDatabase = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // v1 已有 snapshots；旧版浏览器里可能没有则补建
      if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) db.createObjectStore(STORE_SNAPSHOTS);
      // 待提交记录（outbox / WAL）：独立存储，先于任何状态改动落盘
      if (!db.objectStoreNames.contains(STORE_PENDING)) db.createObjectStore(STORE_PENDING);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('数据库被其他标签页占用，请关闭旧标签页后重试'));
  });
  return dbPromise;
};

export async function readEnvelopeIdb(): Promise<PersistedEnvelope | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SNAPSHOTS, 'readonly');
    const request = tx.objectStore(STORE_SNAPSHOTS).get(SNAPSHOT_KEY);
    request.onsuccess = () => resolve((request.result as PersistedEnvelope | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function writeEnvelopeIdb(envelope: PersistedEnvelope): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_SNAPSHOTS, 'readwrite');
    tx.objectStore(STORE_SNAPSHOTS).put(envelope, SNAPSHOT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllPendingIdb(): Promise<PendingCommit[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PENDING, 'readonly');
    const request = tx.objectStore(STORE_PENDING).getAll();
    request.onsuccess = () => resolve((request.result as PendingCommit[] | undefined) ?? []);
    request.onerror = () => reject(request.error);
  });
}

export async function putPendingIdb(commit: PendingCommit): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_PENDING, 'readwrite');
    tx.objectStore(STORE_PENDING).put(commit, commit.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deletePendingIdb(commitId: string): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_PENDING, 'readwrite');
    tx.objectStore(STORE_PENDING).delete(commitId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export interface CommitResult {
  ok: boolean;
  headRevision: number;
}

/**
 * 原子提交：在同一个 readwrite 事务内
 * 1) 校验当前 head 修订仍等于记录的基础修订（乐观并发，防跨标签覆盖）
 * 2) 写入新快照并删除待提交记录
 * 任一步失败整体回滚——绝不会出现快照更新而记录残留（或反之）的中间态。
 */
export async function commitPendingIdb(
  commit: PendingCommit,
  envelope: PersistedEnvelope
): Promise<CommitResult> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let observedHead = 0;
    let abortedForConflict = false;
    const tx = db.transaction([STORE_SNAPSHOTS, STORE_PENDING], 'readwrite');
    const headRequest = tx.objectStore(STORE_SNAPSHOTS).get(SNAPSHOT_KEY);
    headRequest.onsuccess = () => {
      const head = (headRequest.result as PersistedEnvelope | undefined) ?? null;
      observedHead = head?.revision ?? 0;
      if (observedHead !== commit.baseRevision) {
        // 基础修订已被其他标签页推进：放弃本事务，快照与记录都保持原样
        abortedForConflict = true;
        tx.abort();
        return;
      }
      tx.objectStore(STORE_SNAPSHOTS).put(envelope, SNAPSHOT_KEY);
      tx.objectStore(STORE_PENDING).delete(commit.id);
    };
    headRequest.onerror = () => reject(headRequest.error);
    tx.oncomplete = () => resolve({ ok: true, headRevision: envelope.revision });
    tx.onabort = () => {
      // 基础修订冲突时主动 abort：两个存储都保持原样，由调用方标记冲突
      if (abortedForConflict) resolve({ ok: false, headRevision: observedHead });
      // 其他原因的 abort 会经由 onerror 给出错误
    };
    tx.onerror = () => reject(tx.error);
  });
}

/* ------------------------------------------------------------------ */
/* localStorage 降级实现（IndexedDB 不可用时，尽量保持同样的修订语义）    */
/* ------------------------------------------------------------------ */

const lsRead = <T>(key: string): T | null => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

const lsWrite = (key: string, value: unknown) => {
  localStorage.setItem(key, JSON.stringify(value));
};

const readEnvelopeLs = (): PersistedEnvelope | null => lsRead<PersistedEnvelope>(LS_ENVELOPE_KEY);
const writeEnvelopeLs = (envelope: PersistedEnvelope): void => lsWrite(LS_ENVELOPE_KEY, envelope);

const getAllPendingLs = (): PendingCommit[] => {
  const result: PendingCommit[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key?.startsWith(LS_PENDING_PREFIX)) {
      const commit = lsRead<PendingCommit>(key);
      if (commit) result.push(commit);
    }
  }
  return result;
};

const putPendingLs = (commit: PendingCommit): void =>
  lsWrite(`${LS_PENDING_PREFIX}${commit.id}`, commit);

const deletePendingLs = (commitId: string): void =>
  localStorage.removeItem(`${LS_PENDING_PREFIX}${commitId}`);

/**
 * 降级模式下的「提交」：用 storage 事件的串行 JS 执行做修订检查，
 * 无法保证真正的跨标签原子性，但同样不会静默覆盖对方修订。
 */
const commitPendingLs = (commit: PendingCommit, envelope: PersistedEnvelope): CommitResult => {
  const head = readEnvelopeLs();
  const headRevision = head?.revision ?? 0;
  if (headRevision !== commit.baseRevision) return { ok: false, headRevision };
  writeEnvelopeLs(envelope);
  deletePendingLs(commit.id);
  return { ok: true, headRevision: envelope.revision };
};

/* ------------------------------------------------------------------ */
/* 门面：调用方只依赖以下函数                                            */
/* ------------------------------------------------------------------ */

export const storageMode = (): 'indexeddb' | 'localstorage' =>
  idbAvailable() ? 'indexeddb' : 'localstorage';

export async function readEnvelope(): Promise<PersistedEnvelope | null> {
  return idbAvailable() ? readEnvelopeIdb() : readEnvelopeLs();
}

export async function writeEnvelope(envelope: PersistedEnvelope): Promise<void> {
  if (idbAvailable()) await writeEnvelopeIdb(envelope);
  else writeEnvelopeLs(envelope);
}

export async function getAllPending(): Promise<PendingCommit[]> {
  return idbAvailable() ? getAllPendingIdb() : getAllPendingLs();
}

export async function putPending(commit: PendingCommit): Promise<void> {
  if (idbAvailable()) await putPendingIdb(commit);
  else putPendingLs(commit);
}

export async function deletePending(commitId: string): Promise<void> {
  if (idbAvailable()) await deletePendingIdb(commitId);
  else deletePendingLs(commitId);
}

export async function commitPending(
  commit: PendingCommit,
  envelope: PersistedEnvelope
): Promise<CommitResult> {
  return idbAvailable() ? commitPendingIdb(commit, envelope) : commitPendingLs(commit, envelope);
}

/** v1 版本 localStorage 键，启动迁移用 */
export const LEGACY_STATE_KEY = 'sologsb-1019-state-v1';
export const MIRROR_STATE_KEY = 'sologsb-1019-state-v1';
