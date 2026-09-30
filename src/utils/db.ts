import type { PendingCommit, PersistedEnvelope } from '../types';

const DB_NAME = 'sologsb-1019-coding';
const DB_VERSION = 2;
const STORE_NAME = 'snapshots';
const COMMIT_STORE = 'pending-commits';
const SNAPSHOT_KEY = 'current';

const openDatabase = (): Promise<IDBDatabase | null> =>
  new Promise((resolve) => {
    if (!('indexedDB' in window)) {
      resolve(null);
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      if (!db.objectStoreNames.contains(COMMIT_STORE)) db.createObjectStore(COMMIT_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });

export async function readEnvelope(): Promise<PersistedEnvelope | null> {
  const db = await openDatabase();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(SNAPSHOT_KEY);
    request.onsuccess = () => resolve((request.result as PersistedEnvelope | undefined) ?? null);
    request.onerror = () => resolve(null);
    tx.oncomplete = () => db.close();
  });
}

export async function readAllPending(): Promise<PendingCommit[]> {
  const db = await openDatabase();
  if (!db) return [];
  return new Promise((resolve) => {
    const tx = db.transaction(COMMIT_STORE, 'readonly');
    const request = tx.objectStore(COMMIT_STORE).getAll();
    request.onsuccess = () => resolve((request.result as PendingCommit[] | undefined) ?? []);
    request.onerror = () => resolve([]);
    tx.oncomplete = () => db.close();
  });
}

/** 待提交记录先于快照落库 */
export async function putPending(commit: PendingCommit): Promise<void> {
  const db = await openDatabase();
  if (!db) throw new Error('本地数据库不可用');
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(COMMIT_STORE, 'readwrite');
    tx.objectStore(COMMIT_STORE).put(commit, commit.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('待提交记录写入失败'));
    tx.onabort = () => reject(tx.error ?? new Error('待提交记录写入中断'));
  });
  db.close();
}

export interface CommitApplyInput {
  commit: PendingCommit;
  envelope: PersistedEnvelope;
  /** 提交所基于的修订；与库中不一致则视为其他标签已写入，返回 conflict */
  expectedRevision: number;
  /** 提交所基于的最后提交 id；防止不同分支修订号相同（如新标签种子 r1）误判 */
  expectedHeadCommitId: string;
}

export interface CommitApplyResult {
  ok: boolean;
  envelope?: PersistedEnvelope;
  /** expectedRevision 已被其他标签页推进时返回 false，调用方保留提交作为冲突 */
  conflict?: boolean;
}

/**
 * 单事务内：校验基础修订 → 写最终快照 → 删除待提交记录。
 * 任何一步失败整体回滚，记录保留，可恢复重试。
 */
export async function applyPending(input: CommitApplyInput): Promise<CommitApplyResult> {
  const db = await openDatabase();
  if (!db) return { ok: false, conflict: false };
  return new Promise<CommitApplyResult>((resolve) => {
    let settled = false;
    const finish = (result: CommitApplyResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const tx = db.transaction([STORE_NAME, COMMIT_STORE], 'readwrite');
    const snapshotStore = tx.objectStore(STORE_NAME);
    const commitStore = tx.objectStore(COMMIT_STORE);
    const currentReq = snapshotStore.get(SNAPSHOT_KEY);
    currentReq.onsuccess = () => {
      const current = (currentReq.result as PersistedEnvelope | undefined) ?? null;
      // 空库视为可写基线；修订或末端提交任一不同都说明其他标签已推进
      const diverged = !!current && (
        current.revision !== input.expectedRevision ||
        current.state.headCommitId !== input.expectedHeadCommitId
      );
      if (diverged) {
        tx.abort();
        finish({ ok: false, conflict: true });
        return;
      }
      snapshotStore.put(input.envelope, SNAPSHOT_KEY);
      commitStore.delete(input.commit.id);
    };
    currentReq.onerror = () => {
      tx.abort();
      finish({ ok: false, conflict: false });
    };
    tx.oncomplete = () => finish({ ok: true, envelope: input.envelope });
    tx.onerror = () => finish({ ok: false, conflict: false });
    tx.onabort = () => finish({ ok: false, conflict: false });
  }).then((result) => {
    db.close();
    return result;
  });
}

export async function deletePending(commitId: string): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(COMMIT_STORE, 'readwrite');
    tx.objectStore(COMMIT_STORE).delete(commitId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  db.close();
}

export async function deleteManyPending(ids: string[]): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(COMMIT_STORE, 'readwrite');
    const store = tx.objectStore(COMMIT_STORE);
    ids.forEach((id) => store.delete(id));
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  db.close();
}
