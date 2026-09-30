/* IndexedDB outbox 原子提交与冲突测试（fake-indexeddb，node 运行，不进构建） */
import assert from 'node:assert';
import 'fake-indexeddb/auto';
// db 层通过 window.indexedDB 判定存储可用性，node 环境补一个别名
(globalThis as { window?: unknown }).window = globalThis;
import {
  commitPending,
  deletePending,
  getAllPending,
  putPending,
  readEnvelope,
  writeEnvelope
} from '../src/utils/db';
import type { PendingCommit, PersistedEnvelope } from '../src/types';

const stateAt = (revision: number) => ({
  revision, updatedAt: `t${revision}`, activeTranscriptId: '', activeSegmentId: '', activeThemeId: '',
  coderA: 'A', coderB: 'B', transcripts: [], segments: [], themes: [], audit: []
});

const envelopeAt = (revision: number, writerId = 'tab1'): PersistedEnvelope => ({
  revision, updatedAt: `t${revision}`, writerId, state: stateAt(revision)
});

const recordAt = (id: string, baseRevision: number, writerId = 'tab1'): PendingCommit => ({
  id, baseRevision, createdAt: `c${baseRevision}`, writerId, writerLabel: writerId,
  action: '测试', detail: '', change: { kind: 'audit-only' },
  status: 'queued', attemptedAt: 'c', attempts: 0
});

let passed = 0;
const ok = (name: string) => { passed += 1; console.log(`  ✓ ${name}`); };

(async () => {
  /* 1. 初次写入快照 */
  await writeEnvelope(envelopeAt(1));
  assert.equal((await readEnvelope())?.revision, 1);
  ok('readEnvelope 读到初始 r1');

  /* 2. 待提交记录先落盘 */
  await putPending(recordAt('c1', 1));
  const pending1 = await getAllPending();
  assert.equal(pending1.length, 1);
  assert.equal(pending1[0].id, 'c1');
  ok('待提交记录先于快照落盘');

  /* 3. 基础修订匹配：单事务提交成功，快照推进、记录删除 */
  const r3 = await commitPending(recordAt('c1', 1), envelopeAt(2, 'tab1'));
  assert.deepStrictEqual(r3, { ok: true, headRevision: 2 });
  assert.equal((await readEnvelope())?.revision, 2);
  assert.equal((await getAllPending()).length, 0);
  ok('基础修订匹配时原子提交：快照 r2 + 记录已清除');

  /* 4. 模拟「记录落盘后、提交前浏览器关闭」：重开后记录仍在 */
  await putPending(recordAt('c2', 2));
  assert.equal((await getAllPending()).length, 1);
  ok('崩溃后待提交记录仍在（可恢复重试）');

  /* 5. 另一标签页已把 head 推进到 r3：基础修订 r2 的提交必须被拒绝，记录保留 */
  await writeEnvelope(envelopeAt(3, 'tab2'));
  const r5 = await commitPending(recordAt('c2', 2), envelopeAt(3, 'tab1'));
  assert.equal(r5.ok, false);
  assert.equal(r5.headRevision, 3);
  assert.equal((await readEnvelope())?.revision, 3, '对方快照未被覆盖');
  const stillThere = await getAllPending();
  assert.equal(stillThere.length, 1);
  assert.equal(stillThere[0].id, 'c2');
  assert.equal(stillThere[0].status, 'queued', '存储层不擅自改状态，由研究者在 UI 逐项选择');
  ok('基础修订落后时提交被拒：对方 r3 保留，本页记录保留待逐项选择');

  /* 6. 研究者选择「在最新修订上重放」：以 r3 为新基础即可提交 */
  const rebased = { ...recordAt('c2', 2), baseRevision: 3 };
  const r6 = await commitPending(rebased, envelopeAt(4, 'tab1'));
  assert.equal(r6.ok, true);
  assert.equal((await readEnvelope())?.revision, 4);
  assert.equal((await getAllPending()).length, 0);
  ok('逐项重放：以新基础 r3 提交成功到 r4');

  /* 7. 放弃提交：仅删记录，快照不动 */
  await putPending(recordAt('c3', 4));
  await deletePending('c3');
  assert.equal((await getAllPending()).length, 0);
  assert.equal((await readEnvelope())?.revision, 4);
  ok('放弃只清除待提交记录，已提交快照不变');

  /* 8. 快照与记录写入的原子性：事务 abort 后两者都不变 */
  await putPending(recordAt('c4', 4));
  const r8 = await commitPending(recordAt('c4', 99), envelopeAt(5, 'tab1')); // 基础修订故意不符
  assert.equal(r8.ok, false);
  assert.equal((await readEnvelope())?.revision, 4, 'abort 后快照未推进');
  assert.equal((await getAllPending()).length, 1, 'abort 后记录仍在');
  ok('事务 abort 时快照与记录都不产生中间态');

  console.log(`\n全部 ${passed} 项持久化测试通过`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
