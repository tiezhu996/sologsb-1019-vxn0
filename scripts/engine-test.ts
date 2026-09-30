/* 引擎往返一致性测试：esbuild 临时打包后用 node 运行，不进源码包 */
import assert from 'node:assert';
import { applyChange, applyCommit, invertChange, canReapply, affectedEntities } from '../src/store/engine';
import type { CoderId, CodingState, CommitChange, Segment, Theme } from '../src/types';

const mkTheme = (id: string, name: string, parentId: string | null = null): Theme => ({
  id, name, parentId, color: '#000', definition: '', memo: '', examples: []
});

const mkSegment = (id: string): Segment => ({
  id, transcriptId: 'tr-1', order: 0, speaker: 'A', time: '00:00', text: `seg ${id}`,
  assignments: { A: [], B: [] }, note: ''
});

const base = (): CodingState => ({
  revision: 1, updatedAt: 't0', activeTranscriptId: 'tr-1', activeSegmentId: 's1', activeThemeId: 't1',
  coderA: '甲', coderB: '乙',
  transcripts: [{ id: 'tr-1', title: 'T', participant: 'P', importedAt: 't0', sourceName: 'x' }],
  segments: [mkSegment('s1'), mkSegment('s2')],
  themes: [mkTheme('t1', '主题一'), mkTheme('t2', '主题二')],
  audit: []
});

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

const commit = (s: CodingState, change: CommitChange) => applyCommit(s, change, '测试', 'd', new Date().toISOString());

/* 1. assignment 往返 */
check('assignment 正向 + 撤销往返一致', () => {
  const s = base();
  const c: CommitChange = { kind: 'assignment', segmentId: 's1', coder: 'A', themeId: 't1', before: false, after: true };
  commit(s, c);
  assert.deepStrictEqual(s.segments[0].assignments.A, ['t1']);
  assert.equal(s.revision, 2);
  const inv = invertChange(s, c);
  commit(s, inv);
  assert.deepStrictEqual(s.segments[0].assignments.A, []);
  assert.equal(s.revision, 3);
});

/* 2. add-theme -> undo(delete) -> redo(restore) 全链路 */
check('add-theme 撤销（删除并清空引用）与重做（恢复引用）', () => {
  const s = base();
  const add: CommitChange = { kind: 'add-theme', theme: mkTheme('t9', '新主题') };
  commit(s, add);
  s.segments[0].assignments.A = ['t9']; // 撤销前对它产生了引用（模拟真实场景）
  const del = invertChange(s, add);
  assert.equal(del.kind, 'delete-theme');
  commit(s, del);
  assert.ok(!s.themes.find((t) => t.id === 't9'));
  assert.deepStrictEqual(s.segments[0].assignments.A, []);
  const restore = invertChange(s, del);
  assert.equal(restore.kind, 'restore-theme');
  commit(s, restore);
  assert.ok(s.themes.find((t) => t.id === 't9'));
  assert.deepStrictEqual(s.segments[0].assignments.A, ['t9']);
});

/* 3. merge / unmerge 往返 */
check('merge-themes 与 unmerge-themes 精确往返', () => {
  const s = base();
  s.segments[0].assignments.A = ['t1'];
  s.segments[1].assignments.B = ['t1'];
  s.themes.push(mkTheme('t3', '子主题', 't1'));
  const merge: CommitChange = {
    kind: 'merge-themes', sourceId: 't1', targetId: 't2',
    sourceTheme: structuredClone(s.themes.find((t) => t.id === 't1')!),
    reparented: ['t3'],
    assignmentsBefore: { A: { s1: ['t1'] }, B: { s2: ['t1'] } }
  };
  commit(s, merge);
  assert.ok(!s.themes.find((t) => t.id === 't1'));
  assert.deepStrictEqual(s.segments[0].assignments.A, ['t2']);
  assert.equal(s.themes.find((t) => t.id === 't3')?.parentId, 't2');
  const unmerge = invertChange(s, merge);
  assert.equal(unmerge.kind, 'unmerge-themes');
  commit(s, unmerge);
  assert.ok(s.themes.find((t) => t.id === 't1'));
  assert.deepStrictEqual(s.segments[0].assignments.A, ['t1']);
  assert.deepStrictEqual(s.segments[1].assignments.B, ['t1']);
  assert.equal(s.themes.find((t) => t.id === 't3')?.parentId, 't1');
});

/* 4. split / unsplit 往返 */
check('split-theme 与 unsplit-theme 往返', () => {
  const s = base();
  s.segments[0].assignments.A = ['t1'];
  const split: CommitChange = { kind: 'split-theme', sourceId: 't1', theme: mkTheme('t1b', '拆出'), segmentIds: ['s1'] };
  commit(s, split);
  assert.deepStrictEqual(s.segments[0].assignments.A, ['t1b']);
  const unsplit = invertChange(s, split);
  assert.equal(unsplit.kind, 'unsplit-theme');
  commit(s, unsplit);
  assert.deepStrictEqual(s.segments[0].assignments.A, ['t1']);
  assert.ok(!s.themes.find((t) => t.id === 't1b'));
});

/* 5. 冲突重放守卫：目标主题被对方删除时不能重放 assignment */
check('canReapply 在前提实体消失时返回 false', () => {
  const s = base();
  const c: CommitChange = { kind: 'assignment', segmentId: 's1', coder: 'A', themeId: 't9', before: false, after: true };
  assert.equal(canReapply(s, c), false); // t9 不存在
  s.themes.push(mkTheme('t9', 'x'));
  assert.equal(canReapply(s, c), true);
  const delSeg: CommitChange = { kind: 'update-segment', segmentId: 'sx', before: mkSegment('sx') as never, after: mkSegment('sx') as never };
  assert.equal(canReapply(s, delSeg), false);
});

/* 6. import / delete-transcript 往返 + 幂等 */
check('import-transcript 幂等，delete-transcript 是其精确反向', () => {
  const s = base();
  const imp: CommitChange = { kind: 'import-transcript', transcript: { id: 'tr-2', title: 'T2', participant: 'P', importedAt: 't', sourceName: 'm' }, segments: [{ ...mkSegment('s9'), transcriptId: 'tr-2' }] };
  commit(s, imp);
  const n1 = s.segments.length;
  applyChange(s, imp); // 幂等重放不应重复插入
  assert.equal(s.segments.length, n1);
  commit(s, invertChange(s, imp));
  assert.ok(!s.transcripts.find((t) => t.id === 'tr-2'));
  assert.ok(!s.segments.find((seg) => seg.id === 's9'));
});

/* 7. affectedEntities */
check('affectedEntities 提取主题与片段', () => {
  const c: CommitChange = { kind: 'batch-assign', segmentIds: ['s1', 's2'], coder: 'A' as CoderId, themeId: 't1', before: {}, after: true };
  const a = affectedEntities(c);
  assert.deepStrictEqual(a.themeIds, ['t1']);
  assert.deepStrictEqual(a.segmentIds.sort(), ['s1', 's2']);
});

/* 8. update-theme 往返 */
check('update-theme before/after 交换往返', () => {
  const s = base();
  const c: CommitChange = { kind: 'update-theme', themeId: 't1', before: { name: '主题一' }, after: { name: '改名' } };
  commit(s, c);
  assert.equal(s.themes[0].name, '改名');
  commit(s, invertChange(s, c));
  assert.equal(s.themes[0].name, '主题一');
});

/* 9. restore-theme 幂等保护：id 已被占用时不可重放 */
check('restore-theme 在 id 被占用时拒绝重放', () => {
  const s = base();
  const c: CommitChange = { kind: 'restore-theme', theme: mkTheme('t1', '冲突'), assignments: { A: {}, B: {} }, orphaned: [] };
  assert.equal(canReapply(s, c), false);
});

console.log(`\n全部 ${passed} 项引擎测试通过`);
