import type { CodingOperation, CodingState, ConflictMarker } from '../types';

const CONFLICT_LIMIT = 200;

const addConflict = (
  conflicts: ConflictMarker[],
  commitId: string,
  kind: ConflictMarker['kind'],
  message: string,
  at: string
) => {
  if (conflicts.filter((item) => !item.resolved).length >= CONFLICT_LIMIT) return;
  conflicts.push({ id: `c-${crypto.randomUUID()}`, commitId, kind, message, detectedAt: at, resolved: false });
};

/**
 * 把一次提交操作应用到草稿状态上。纯函数：不修改入参，返回新状态与新增冲突。
 * 主题树、片段判断、审计与冲突标记在同一次应用里一起推进，不会出现互相对不上。
 */
export function applyOperation(
  state: CodingState,
  operation: CodingOperation,
  meta: { commitId: string; at: string; action: string; detail: string }
): CodingState {
  const next: CodingState = structuredClone(state);
  const themeIds = new Set(next.themes.map((theme) => theme.id));
  const segmentIds = new Set(next.segments.map((segment) => segment.id));

  switch (operation.type) {
    case 'restore': {
      const carried = { revision: next.revision, updatedAt: next.updatedAt, headCommitId: next.headCommitId };
      Object.assign(next, structuredClone(operation.snapshot), carried);
      break;
    }
    case 'setCoder': {
      if (operation.coder === 'A') next.coderA = operation.name;
      else next.coderB = operation.name;
      break;
    }
    case 'toggleAssignment': {
      const segment = next.segments.find((item) => item.id === operation.segmentId);
      if (!segment) {
        addConflict(next.conflicts, meta.commitId, 'missing-segment', `片段 ${operation.segmentId} 已不存在，编码者${operation.coder} 的主题判断未应用`, meta.at);
        break;
      }
      if (!themeIds.has(operation.themeId)) {
        addConflict(next.conflicts, meta.commitId, 'missing-theme', `主题 ${operation.themeId} 已被其他标签页删除，编码者${operation.coder} 对片段的判断未应用`, meta.at);
        break;
      }
      const codes = new Set(segment.assignments[operation.coder]);
      if (operation.enabled) codes.add(operation.themeId);
      else codes.delete(operation.themeId);
      segment.assignments[operation.coder] = [...codes];
      break;
    }
    case 'batchAssign': {
      if (!themeIds.has(operation.themeId)) {
        addConflict(next.conflicts, meta.commitId, 'missing-theme', `批量重编码的目标主题 ${operation.themeId} 已不存在，${operation.segmentIds.length} 个片段未应用`, meta.at);
        break;
      }
      let missing = 0;
      next.segments.forEach((segment) => {
        if (!operation.segmentIds.includes(segment.id)) return;
        if (!segmentIds.has(segment.id)) {
          missing += 1;
          return;
        }
        if (!segment.assignments[operation.coder].includes(operation.themeId)) {
          segment.assignments[operation.coder].push(operation.themeId);
        }
      });
      if (missing) addConflict(next.conflicts, meta.commitId, 'missing-segment', `${missing} 个片段在重放时缺失，批量重编码部分未应用`, meta.at);
      break;
    }
    case 'addTheme': {
      if (themeIds.has(operation.id)) break;
      if (operation.parentId && !themeIds.has(operation.parentId)) {
        addConflict(next.conflicts, meta.commitId, 'missing-theme', `父主题 ${operation.parentId} 已不存在，新主题“${operation.name}”改为一级主题`, meta.at);
        next.themes.push({ id: operation.id, name: operation.name, parentId: null, color: operation.color, definition: '', memo: '', examples: [] });
      } else {
        next.themes.push({ id: operation.id, name: operation.name, parentId: operation.parentId, color: operation.color, definition: '', memo: '', examples: [] });
      }
      next.activeThemeId = operation.id;
      break;
    }
    case 'updateTheme': {
      const theme = next.themes.find((item) => item.id === operation.themeId);
      if (!theme) addConflict(next.conflicts, meta.commitId, 'missing-theme', `主题 ${operation.themeId} 已被删除，定义/备忘录修改未应用`, meta.at);
      else Object.assign(theme, operation.patch);
      break;
    }
    case 'deleteTheme': {
      const exists = next.themes.some((item) => item.id === operation.themeId);
      next.themes = next.themes.filter((item) => item.id !== operation.themeId);
      next.themes.forEach((item) => { if (item.parentId === operation.themeId) item.parentId = null; });
      next.segments.forEach((segment) => {
        segment.assignments.A = segment.assignments.A.filter((id) => id !== operation.themeId);
        segment.assignments.B = segment.assignments.B.filter((id) => id !== operation.themeId);
      });
      if (next.activeThemeId === operation.themeId) next.activeThemeId = next.themes[0]?.id ?? '';
      if (!exists) addConflict(next.conflicts, meta.commitId, 'missing-theme', `要删除的主题 ${operation.themeId} 已不存在`, meta.at);
      break;
    }
    case 'mergeThemes': {
      const sourceExists = themeIds.has(operation.sourceId);
      const targetExists = themeIds.has(operation.targetId);
      if (!targetExists) {
        addConflict(next.conflicts, meta.commitId, 'missing-theme', `合并目标主题 ${operation.targetId} 已不存在，合并未应用`, meta.at);
        break;
      }
      next.segments.forEach((segment) => {
        (['A', 'B'] as const).forEach((coder) => {
          const codes = new Set(segment.assignments[coder].filter((id) => id !== operation.sourceId));
          if (segment.assignments[coder].includes(operation.sourceId)) codes.add(operation.targetId);
          segment.assignments[coder] = [...codes];
        });
      });
      next.themes.forEach((theme) => { if (theme.parentId === operation.sourceId) theme.parentId = operation.targetId; });
      next.themes = next.themes.filter((theme) => theme.id !== operation.sourceId);
      next.activeThemeId = operation.targetId;
      if (!sourceExists) addConflict(next.conflicts, meta.commitId, 'missing-theme', `合并来源主题 ${operation.sourceId} 在重放时已不存在，仅完成引用迁移`, meta.at);
      break;
    }
    case 'splitTheme': {
      const source = next.themes.find((theme) => theme.id === operation.sourceId);
      if (!source) {
        addConflict(next.conflicts, meta.commitId, 'missing-theme', `拆分来源主题 ${operation.sourceId} 已不存在，拆分未应用`, meta.at);
        break;
      }
      if (!themeIds.has(operation.newId)) next.themes.push({ ...structuredClone(source), id: operation.newId, name: operation.newName, examples: [] });
      next.segments.forEach((segment) => {
        if (!operation.segmentIds.includes(segment.id)) return;
        (['A', 'B'] as const).forEach((coder) => {
          if (segment.assignments[coder].includes(operation.sourceId)) {
            segment.assignments[coder] = segment.assignments[coder].map((id) => (id === operation.sourceId ? operation.newId : id));
          }
        });
      });
      next.activeThemeId = operation.newId;
      break;
    }
    case 'updateSegment': {
      const segment = next.segments.find((item) => item.id === operation.segmentId);
      if (!segment) addConflict(next.conflicts, meta.commitId, 'missing-segment', `片段 ${operation.segmentId} 已不存在，备忘修改未应用`, meta.at);
      else Object.assign(segment, operation.patch);
      break;
    }
    case 'addExample': {
      const theme = next.themes.find((item) => item.id === operation.themeId);
      if (!theme) addConflict(next.conflicts, meta.commitId, 'missing-theme', `主题 ${operation.themeId} 已被删除，示例未添加`, meta.at);
      else if (!theme.examples.includes(operation.example)) theme.examples.push(operation.example);
      break;
    }
    case 'importTranscript': {
      if (next.transcripts.some((item) => item.id === operation.transcript.id)) {
        addConflict(next.conflicts, meta.commitId, 'missing-transcript', `转写 ${operation.transcript.id} 已导入，跳过重复导入`, meta.at);
        break;
      }
      next.transcripts.push(structuredClone(operation.transcript));
      next.segments.push(...structuredClone(operation.segments));
      next.activeTranscriptId = operation.transcript.id;
      next.activeSegmentId = operation.segments[0]?.id ?? next.activeSegmentId;
      break;
    }
    case 'resolveConflict': {
      const marker = next.conflicts.find((item) => item.id === operation.markerId);
      if (marker) marker.resolved = true;
      break;
    }
  }

  next.revision = state.revision + 1;
  next.updatedAt = meta.at;
  next.headCommitId = meta.commitId;
  if (operation.type !== 'restore') {
    next.audit.unshift({ id: `a-${meta.commitId}`, at: meta.at, action: meta.action, detail: meta.detail });
    next.audit = next.audit.slice(0, 250);
  }
  return next;
}

/** 把一个基础修订上的提交按顺序投影到最新状态（乐观界面与恢复共用） */
export function replayCommits(
  base: CodingState,
  commits: Array<{ id: string; createdAt: string; action: string; detail: string; operation: CodingOperation }>
): CodingState {
  return commits.reduce(
    (acc, commit) => applyOperation(acc, commit.operation, { commitId: commit.id, at: commit.createdAt, action: commit.action, detail: commit.detail }),
    base
  );
}

/** 评估提交在当前状态上重放会产生哪些冲突说明（不修改状态） */
export function dryRunConflicts(state: CodingState, operation: CodingOperation, commitId: string, at: string): string[] {
  const probe = applyOperation(state, operation, { commitId, at, action: 'probe', detail: 'probe' });
  return probe.conflicts
    .filter((marker) => !marker.resolved && marker.commitId === commitId && state.conflicts.every((item) => item.id !== marker.id))
    .map((marker) => marker.message);
}
