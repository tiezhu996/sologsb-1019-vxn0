/*
 * store 端到端测试：用 Solid 桩 + fake-indexeddb 跑真实的
 * initialize → 编码入队 → 原子提交 → 冲突 → 逐项重放 → 崩溃恢复 流程。
 * store 是模块级单例，多个 useCodingStore() 共享状态，正好模拟同一浏览器里的多个标签。
 */
import assert from 'node:assert';
import 'fake-indexeddb/auto';
(globalThis as { window?: unknown }).window = globalThis;
if (typeof (globalThis as { addEventListener?: unknown }).addEventListener !== 'function') {
  (globalThis as { addEventListener: () => void }).addEventListener = () => {};
}

const lsMap = new Map<string, string>();
(globalThis as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => (lsMap.has(k) ? lsMap.get(k)! : null),
  setItem: (k: string, v: string) => void lsMap.set(k, String(v)),
  removeItem: (k: string) => void lsMap.delete(k),
  clear: () => lsMap.clear(),
  key: (i: number) => [...lsMap.keys()][i] ?? null,
  get length() { return lsMap.size; }
} as Storage;

// BroadcastChannel 桩：同进程内直连，模拟两个标签页
class StubChannel {
  static channels: StubChannel[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(public name: string) { StubChannel.channels.push(this); }
  postMessage(data: unknown) {
    StubChannel.channels
      .filter((c) => c !== this && c.name === this.name)
      .forEach((c) => queueMicrotask(() => c.onmessage?.({ data })));
  }
}
(globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = StubChannel;

import { useCodingStore } from '../src/store/coding-store';
import { getAllPending, putPending, readEnvelope } from '../src/utils/db';

const flush = () => new Promise((r) => setTimeout(r, 20));

let passed = 0;
const ok = (name: string) => { passed += 1; console.log(`  ✓ ${name}`); };

(async () => {
  /* ---------- 用例 1：正常编码 → 提交 → 记录清除 ---------- */
  {
    const store = useCodingStore();
    await store.initialize();
    await flush();
    const target = store.state.segments[0];
    const revisionBefore = store.state.revision;
    store.toggleAssignment(target.id, 'A', 't-work', true);
    await flush();
    assert.ok(store.state.segments.find((x) => x.id === target.id)!.assignments.A.includes('t-work'), '主题判断已写入状态');
    assert.equal(store.state.revision, revisionBefore + 1, '修订号 +1');
    assert.equal(store.pendingCommits().length, 0, '提交成功后记录已清除');
    assert.equal(store.state.audit[0].action, '调整编码', '审计记录已写入');
    ok('编码改动：记录落盘 → 主题/片段/审计原子提交 → 记录清除');
  }

  /* ---------- 用例 2：撤销/重做基于记录反向重放 ---------- */
  {
    const store = useCodingStore();
    const target = store.state.segments[0];
    const before = [...store.state.segments.find((x) => x.id === target.id)!.assignments.A];
    store.undo === undefined; // 仅确保 store 可用
    // 再加一个新判断用于撤销
    store.toggleAssignment(target.id, 'A', 't-migration', true);
    await flush();
    assert.equal(store.canUndo(), true, '成功提交后撤销栈才推进');
    store.undo();
    await flush();
    assert.deepStrictEqual(
      store.state.segments.find((x) => x.id === target.id)!.assignments.A,
      before,
      '撤销恢复原判断'
    );
    assert.ok(store.state.audit[0].action.startsWith('撤销'), '撤销写入审计');
    store.redo();
    await flush();
    assert.ok(store.state.segments.find((x) => x.id === target.id)!.assignments.A.includes('t-migration'), '重做再次应用');
    ok('撤销/重做：反向记录提交，审计与修订同步');
  }

  /* ---------- 用例 3：两个标签页并发，后到一方不覆盖对方 ---------- */
  {
    const storeA = useCodingStore();
    const storeB = useCodingStore(); // 同一模块单例 = 同一标签会话；再用底层 API 模拟另一标签的 head 推进

    // A 完成一笔提交（当前修订再 +1）
    const segA = storeA.state.segments[1];
    storeA.toggleAssignment(segA.id, 'A', 't-work', true);
    await flush();

    // 直接在底层构造「另一标签页已提交 r+1」，并放一条本页基于旧修订的在途记录
    const head = await readEnvelope();
    assert.ok(head);
    const remoteBase = head!.revision;
    await putPending({
      id: 'c-tab-b-queued',
      baseRevision: remoteBase,
      createdAt: new Date(Date.now() + 1).toISOString(),
      writerId: 'tab-b',
      writerLabel: '另一个标签页',
      action: '调整编码',
      detail: 'B 的在途改动',
      change: { kind: 'assignment', segmentId: storeB.state.segments[2].id, coder: 'B', themeId: 't-family', before: false, after: true },
      status: 'queued',
      attemptedAt: new Date().toISOString(),
      attempts: 0
    });
    // 模拟对方先把 head 推进：写入 remoteBase+1 的快照
    const remoteState = structuredClone(head!.state);
    remoteState.revision = remoteBase + 1;
    remoteState.updatedAt = new Date().toISOString();
    remoteState.audit.unshift({ id: 'a-remote', at: remoteState.updatedAt, action: '对方标签页提交', detail: '并发用例' });
    const { writeEnvelope } = await import('../src/utils/db');
    await writeEnvelope({ revision: remoteState.revision, updatedAt: remoteState.updatedAt, writerId: 'tab-remote', state: remoteState });

    // 面板从库中同步到那条在途记录，再驱动队列：commitPending 的修订检查会拦下它
    await storeA.refreshPending();
    assert.ok(storeA.pendingCommits().some((c) => c.id === 'c-tab-b-queued' && c.status === 'queued'));
    await storeA.drainQueue();
    await flush();
    const conflicted = useCodingStore().pendingCommits().find((c) => c.id === 'c-tab-b-queued');
    assert.ok(conflicted && conflicted.status === 'conflicted', '基础修订落后的在途记录被标记为冲突');
    assert.equal(useCodingStore().state.revision, remoteBase + 1, '本页已载入对方最新修订，未覆盖对方');

    // 研究者逐项选择「在最新修订上重放」
    useCodingStore().reapplyCommit('c-tab-b-queued');
    await flush();
    const still = useCodingStore().pendingCommits().find((c) => c.id === 'c-tab-b-queued');
    assert.ok(!still, '旧冲突记录已移除');
    assert.ok(
      useCodingStore().state.segments.find((x) => x.id === remoteState.segments[2].id)!.assignments.B.includes('t-family'),
      'B 的改动在最新修订上重放成功'
    );
    assert.ok(
      useCodingStore().state.audit.some((a) => a.action === '对方标签页提交'),
      '对方的审计/内容仍然保留，没有被覆盖'
    );
    ok('跨标签并发：提交被修订检查拦下，双方内容保留，逐项重放后合流');

    // 放弃路径：再造一条冲突记录然后放弃，应只留审计不改动数据
    const head2 = await readEnvelope();
    await putPending({
      id: 'c-tab-b-giveup',
      baseRevision: head2!.revision - 5,
      createdAt: new Date(Date.now() + 2).toISOString(),
      writerId: 'tab-b',
      writerLabel: '另一个标签页',
      action: '编辑片段',
      detail: '将被放弃',
      change: { kind: 'audit-only' },
      status: 'conflicted',
      attemptedAt: new Date().toISOString(),
      attempts: 1,
      headRevision: head2!.revision
    });
    const revisionNow = useCodingStore().state.revision;
    await useCodingStore().refreshPending();
    assert.ok(useCodingStore().pendingCommits().some((c) => c.id === 'c-tab-b-giveup'));
    useCodingStore().discardCommit('c-tab-b-giveup');
    await flush();
    await flush();
    assert.ok(!useCodingStore().pendingCommits().find((c) => c.id === 'c-tab-b-giveup'), '放弃后记录删除');
    assert.equal(useCodingStore().state.audit[0].action, '放弃未完成提交', '放弃写入审计留痕');
    assert.ok(useCodingStore().state.revision > revisionNow, '放弃本身是一次已提交修订');
    ok('放弃未完成提交：记录移除、审计留痕、数据不回滚');
  }

  /* ---------- 用例 4：崩溃恢复（记录已落盘、未提交，重开自动补上） ---------- */
  {
    const head = await readEnvelope();
    const crashedId = 'c-crashed';
    await putPending({
      id: crashedId,
      baseRevision: head!.revision,
      createdAt: new Date(Date.now() + 3).toISOString(),
      writerId: 'dead-tab',
      writerLabel: '已崩溃标签页',
      action: '调整编码',
      detail: '崩溃恢复用例',
      change: { kind: 'assignment', segmentId: head!.state.segments[0].id, coder: 'A', themeId: 't-migration', before: false, after: true },
      status: 'queued',
      attemptedAt: new Date().toISOString(),
      attempts: 0
    });
    const store = useCodingStore();
    const revisionBefore = store.state.revision;
    // 面板同步到落盘记录后再驱动队列；等价于重开时 initialize → syncPendingFromDb → drain 的恢复路径
    await store.refreshPending();
    await store.drainQueue();
    await flush();
    assert.ok(store.state.segments[0].assignments.A.includes('t-migration'), '崩溃标签页的改动重放成功');
    assert.ok(store.state.revision > revisionBefore, '恢复提交推进了修订');
    assert.equal(store.pendingCommits().filter((c) => c.id === crashedId).length, 0, '恢复提交后记录清除');
    ok('崩溃恢复：在途记录重放成功，成功后才清除记录');
  }

  /* ---------- 用例 5：冲突记录重开后仍然保留，不自动重放 ---------- */
  {
    const head = await readEnvelope();
    await putPending({
      id: 'c-old-conflict',
      baseRevision: head!.revision - 99,
      createdAt: new Date(Date.now() + 4).toISOString(),
      writerId: 'other-tab',
      writerLabel: '其他标签页',
      action: '调整编码',
      detail: '旧冲突',
      change: { kind: 'assignment', segmentId: head!.state.segments[0].id, coder: 'B', themeId: 't-teacher', before: false, after: true },
      status: 'conflicted',
      attemptedAt: new Date().toISOString(),
      attempts: 1,
      headRevision: head!.revision
    });
    // initialize 不重放 conflicted 记录；面板同步后它应仍为 conflicted 状态
    const store = useCodingStore();
    await store.refreshPending();
    const kept = store.pendingCommits().find((c) => c.id === 'c-old-conflict');
    assert.ok(kept && kept.status === 'conflicted', '旧冲突同步后面板可见且仍为冲突，不会自动重放');
    ok('冲突记录重开后保留，等待研究者逐项选择');
  }

  /* ---------- 用例 6：导出包含最终修订与未完成提交 ---------- */
  {
    const store = useCodingStore();
    await store.refreshPending();
    const json = JSON.parse(store.exportCoding('json'));
    assert.equal(json.finalRevision, store.state.revision, '导出含最终修订');
    assert.ok(Array.isArray(json.pendingCommits), '导出含未完成提交数组');
    const entry = json.pendingCommits.find((c: { id: string }) => c.id === 'c-old-conflict');
    assert.ok(entry, '未完成提交中包含冲突记录');
    assert.equal(entry.status, 'conflicted');
    assert.ok(entry.affected && typeof entry.baseRevision === 'number', '含影响实体与基础修订');
    ok('导出 JSON：finalRevision + pendingCommits（含状态/基础修订/影响实体）');
  }

  console.log(`\n全部 ${passed} 项 store 端到端测试通过`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
