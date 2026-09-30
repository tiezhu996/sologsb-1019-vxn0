import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOperation, replayCommits, dryRunConflicts } from '../src/store/operations.ts';
import { seedState } from '../src/data/seed.ts';

// operations.ts 用 crypto.randomUUID() 生成冲突标记 id；Node 20 已带全局 webcrypto
const seed = () => seedState();
const meta = (overrides = {}) => ({
  commitId: `c-${Math.random().toString(36).slice(2)}`,
  at: new Date().toISOString(),
  action: '测试操作',
  detail: '测试',
  ...overrides
});

test('每次提交都推进修订、记录审计并更新 headCommitId', () => {
  const base = seed();
  const themeId = `t-${Math.random().toString(36).slice(2)}`;
  const next = applyOperation(base, { type: 'addTheme', id: themeId, name: '新主题', parentId: null, color: '#000' }, meta());
  assert.equal(next.revision, base.revision + 1);
  assert.equal(next.headCommitId.startsWith('c-'), true);
  assert.equal(next.themes.length, base.themes.length + 1);
  assert.equal(next.audit[0].detail, '测试');
  assert.equal(next.audit[0].id, `a-${next.headCommitId}`);
  // 不修改输入
  assert.equal(base.themes.length, next.themes.length - 1);
  assert.equal(base.revision, next.revision - 1);
});

test('主题、片段判断在同一次提交里原子推进，不会对不上', () => {
  const base = seed();
  const segmentId = base.segments[0].id;
  const themeId = base.themes[0].id;
  const next = applyOperation(
    base,
    { type: 'toggleAssignment', segmentId, coder: 'A', themeId, enabled: true },
    meta()
  );
  assert.deepEqual(next.segments[0].assignments.A.includes(themeId), true);
  assert.equal(next.revision, base.revision + 1);
  assert.equal(next.audit.length, base.audit.length + 1);
  assert.equal(next.conflicts.filter((c) => !c.resolved).length, 0);
});

test('引用已删除主题时不破坏片段判断，并产生冲突标记', () => {
  const base = seed();
  const next = applyOperation(
    base,
    { type: 'toggleAssignment', segmentId: base.segments[0].id, coder: 'A', themeId: 't-gone', enabled: true },
    meta({ commitId: 'c-x' })
  );
  assert.deepEqual(next.segments[0].assignments.A, base.segments[0].assignments.A);
  const open = next.conflicts.filter((c) => !c.resolved);
  assert.equal(open.length, 1);
  assert.equal(open[0].kind, 'missing-theme');
  assert.equal(open[0].commitId, 'c-x');
});

test('删除主题时片段判断中的引用一并迁移，保持引用一致', () => {
  const base = seed();
  const target = base.themes[0].id;
  // 先确保有引用
  const withAssign = applyOperation(
    base,
    { type: 'toggleAssignment', segmentId: base.segments[2].id, coder: 'B', themeId: target, enabled: true },
    meta()
  );
  const removed = applyOperation(withAssign, { type: 'deleteTheme', themeId: target }, meta());
  assert.equal(removed.themes.some((t) => t.id === target), false);
  removed.segments.forEach((segment) => {
    assert.equal(segment.assignments.A.includes(target), false);
    assert.equal(segment.assignments.B.includes(target), false);
  });
});

test('按带基础修订的日志顺序重放后，最终修订等于基础修订加提交数', () => {
  const base = seed();
  const commits = Array.from({ length: 3 }, (_, i) => ({
    id: `c-r${i}`,
    createdAt: new Date(Date.now() + i).toISOString(),
    action: '新建主题',
    detail: `主题${i}`,
    operation: { type: 'addTheme', id: `t-r${i}`, name: `主题${i}`, parentId: null, color: '#000' }
  }));
  const final = replayCommits(base, commits);
  assert.equal(final.revision, base.revision + 3);
  assert.equal(final.themes.length, base.themes.length + 3);
  assert.equal(final.headCommitId, 'c-r2');
});

test('dryRunConflicts 能预判某提交在新基础上的对不上原因', () => {
  const base = seed();
  // 基础上没有 t-gone
  const reasons = dryRunConflicts(
    base,
    { type: 'addExample', themeId: 't-gone', example: '例子' },
    'c-dry',
    new Date().toISOString()
  );
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /已被删除/);
});

test('撤销 restore 提交恢复视图字段但携带当前修订推进', () => {
  const base = seed();
  const edited = applyOperation(
    base,
    { type: 'toggleAssignment', segmentId: base.segments[0].id, coder: 'A', themeId: base.themes[0].id, enabled: true },
    meta()
  );
  const { revision: _r, updatedAt: _u, headCommitId: _h, ...snapshot } = base;
  const restored = applyOperation(edited, { type: 'restore', snapshot }, meta({ action: '撤销编码', detail: '回退' }));
  assert.deepEqual(restored.segments[0].assignments.A, base.segments[0].assignments.A);
  assert.equal(restored.revision, edited.revision + 1);
});
