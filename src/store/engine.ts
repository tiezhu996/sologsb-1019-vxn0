import type { AuditEntry, CoderId, CodingState, CommitChange } from '../types';

/** 新审计条目，统一从这里产生时间戳 */
export const makeAudit = (action: string, detail: string, at = new Date().toISOString()): AuditEntry => ({
  id: `a-${crypto.randomUUID()}`,
  at,
  action,
  detail
});

const bumpRevision = (draft: CodingState, at: string) => {
  draft.revision += 1;
  draft.updatedAt = at;
};

const pushAudit = (draft: CodingState, action: string, detail: string, at: string) => {
  draft.audit.unshift(makeAudit(action, detail, at));
  draft.audit = draft.audit.slice(0, 250);
};

/** 删除主题时引用它的片段编码与子主题的处理（delete-theme 与 merge-themes 复用） */
const detachAssignments = (draft: CodingState, themeId: string, replacementId?: string) => {
  draft.segments.forEach((segment) => {
    (['A', 'B'] as CoderId[]).forEach((coder) => {
      if (!segment.assignments[coder].includes(themeId)) return;
      const codes = segment.assignments[coder].filter((id) => id !== themeId);
      if (replacementId) codes.push(replacementId);
      segment.assignments[coder] = [...new Set(codes)];
    });
  });
};

/**
 * 把一条变更记录应用到给定状态（就地修改 draft）。
 * 返回 false 表示在该基础修订上结构性不可重放（前提已不存在），用于冲突后的保守处理。
 */
export function applyChange(draft: CodingState, change: CommitChange): boolean {
  const at = new Date().toISOString();
  switch (change.kind) {
    case 'assignment': {
      const segment = draft.segments.find((item) => item.id === change.segmentId);
      if (!segment) return false;
      if (change.after && !draft.themes.some((theme) => theme.id === change.themeId)) return false;
      const codes = new Set(segment.assignments[change.coder]);
      if (change.after) codes.add(change.themeId);
      else codes.delete(change.themeId);
      segment.assignments[change.coder] = [...codes];
      return true;
    }
    case 'batch-assign': {
      if (change.after && !draft.themes.some((theme) => theme.id === change.themeId)) return false;
      let touched = false;
      draft.segments.forEach((segment) => {
        if (!change.segmentIds.includes(segment.id)) return;
        const codes = new Set(segment.assignments[change.coder]);
        if (change.after) { touched = true; codes.add(change.themeId); }
        else codes.delete(change.themeId);
        segment.assignments[change.coder] = [...codes];
      });
      return touched || change.segmentIds.length === 0;
    }
    case 'add-theme': {
      if (draft.themes.some((theme) => theme.id === change.theme.id)) return true; // 幂等：重放时已存在
      if (change.theme.parentId && !draft.themes.some((theme) => theme.id === change.theme.parentId)) {
        draft.themes.push({ ...change.theme, parentId: null }); // 父主题已消失时降级为一级主题
      } else {
        draft.themes.push(structuredClone(change.theme));
      }
      draft.activeThemeId = change.theme.id;
      return true;
    }
    case 'delete-theme': {
      const theme = draft.themes.find((item) => item.id === change.themeId);
      if (!theme) return true; // 已被删除（例如被合并），视为可接受的幂等结果
      detachAssignments(draft, change.themeId);
      draft.themes.forEach((item) => { if (item.parentId === change.themeId) item.parentId = null; });
      draft.themes = draft.themes.filter((item) => item.id !== change.themeId);
      if (draft.activeThemeId === change.themeId) draft.activeThemeId = draft.themes[0]?.id ?? '';
      return true;
    }
    case 'restore-theme': {
      // 删除的精确反向：恢复主题、引用它的片段编码，以及被降级为一级的子主题
      if (!draft.themes.some((item) => item.id === change.theme.id)) draft.themes.push(structuredClone(change.theme));
      draft.segments.forEach((segment) => {
        (['A', 'B'] as CoderId[]).forEach((coder) => {
          const saved = change.assignments[coder][segment.id];
          if (saved) segment.assignments[coder] = structuredClone(saved);
        });
      });
      change.orphaned.forEach((entry) => {
        const child = draft.themes.find((item) => item.id === entry.id);
        if (child) child.parentId = change.theme.id;
      });
      draft.activeThemeId = change.theme.id;
      return true;
    }
    case 'update-theme': {
      const theme = draft.themes.find((item) => item.id === change.themeId);
      if (!theme) return false;
      Object.entries(change.after).forEach(([key, value]) => {
        (theme as unknown as Record<string, unknown>)[key] = structuredClone(value);
      });
      return true;
    }
    case 'merge-themes': {
      const source = draft.themes.find((item) => item.id === change.sourceId);
      const target = draft.themes.find((item) => item.id === change.targetId);
      if (!target) return false; // 目标主题消失，无法迁移
      if (!source) return true;  // 来源已不在，幂等
      detachAssignments(draft, change.sourceId, change.targetId);
      draft.themes.forEach((theme) => { if (theme.parentId === change.sourceId) theme.parentId = change.targetId; });
      draft.themes = draft.themes.filter((theme) => theme.id !== change.sourceId);
      draft.activeThemeId = change.targetId;
      return true;
    }
    case 'unmerge-themes': {
      // 合并的精确反向：来源主题回归、编码引用还原、子主题重新挂回
      const target = draft.themes.find((item) => item.id === change.targetId);
      if (!target) return false;
      if (!draft.themes.some((item) => item.id === change.sourceTheme.id)) draft.themes.push(structuredClone(change.sourceTheme));
      draft.segments.forEach((segment) => {
        (['A', 'B'] as CoderId[]).forEach((coder) => {
          const saved = change.assignmentsBefore[coder][segment.id];
          if (saved) segment.assignments[coder] = structuredClone(saved);
        });
      });
      change.reparented.forEach((id) => {
        const child = draft.themes.find((item) => item.id === id);
        if (child) child.parentId = change.sourceTheme.id;
      });
      draft.activeThemeId = change.sourceTheme.id;
      return true;
    }
    case 'split-theme': {
      if (!draft.themes.some((theme) => theme.id === change.sourceId)) return false;
      if (!draft.themes.some((theme) => theme.id === change.theme.id)) draft.themes.push(structuredClone(change.theme));
      draft.segments.forEach((segment) => {
        if (!change.segmentIds.includes(segment.id)) return;
        (['A', 'B'] as CoderId[]).forEach((coder) => {
          if (segment.assignments[coder].includes(change.sourceId)) {
            segment.assignments[coder] = segment.assignments[coder].map((id) => id === change.sourceId ? change.theme.id : id);
          }
        });
      });
      draft.activeThemeId = change.theme.id;
      return true;
    }
    case 'unsplit-theme': {
      // 拆分的精确反向：新主题删除，片段上的新主题 id 换回来源主题
      const source = draft.themes.find((theme) => theme.id === change.sourceId);
      if (!source) return false;
      draft.segments.forEach((segment) => {
        if (!change.segmentIds.includes(segment.id)) return;
        (['A', 'B'] as CoderId[]).forEach((coder) => {
          if (segment.assignments[coder].includes(change.theme.id)) {
            segment.assignments[coder] = segment.assignments[coder]
              .map((id) => (id === change.theme.id ? change.sourceId : id));
          }
        });
      });
      draft.themes = draft.themes.filter((theme) => theme.id !== change.theme.id);
      draft.activeThemeId = change.sourceId;
      return true;
    }
    case 'update-segment': {
      const segment = draft.segments.find((item) => item.id === change.segmentId);
      if (!segment) return false;
      Object.assign(segment, structuredClone(change.after));
      return true;
    }
    case 'import-transcript': {
      if (draft.transcripts.some((item) => item.id === change.transcript.id)) return true; // 幂等
      draft.transcripts.push(structuredClone(change.transcript));
      draft.segments.push(...structuredClone(change.segments));
      draft.activeTranscriptId = change.transcript.id;
      draft.activeSegmentId = change.segments[0]?.id ?? draft.activeSegmentId;
      return true;
    }
    case 'delete-transcript': {
      // 导入的精确反向：整组移除（新导入的访谈尚无编码改动，删除是安全的）
      const ids = new Set(change.segments.map((segment) => segment.id));
      draft.segments = draft.segments.filter((segment) => !ids.has(segment.id));
      draft.transcripts = draft.transcripts.filter((item) => item.id !== change.transcript.id);
      if (draft.activeTranscriptId === change.transcript.id) {
        draft.activeTranscriptId = draft.transcripts[0]?.id ?? '';
        draft.activeSegmentId = draft.segments.find((segment) => segment.transcriptId === draft.activeTranscriptId)?.id ?? '';
      }
      return true;
    }
    case 'add-example': {
      const theme = draft.themes.find((item) => item.id === change.themeId);
      if (!theme) return false;
      if (!theme.examples.includes(change.example)) theme.examples.push(change.example);
      return true;
    }
    case 'rename-coder': {
      if (change.coder === 'A') draft.coderA = change.after;
      else draft.coderB = change.after;
      return true;
    }
    case 'audit-only':
      return true;
    default:
      return false;
  }
}

/** 应用一条提交：变更 + 修订号 + 审计条目 */
export function applyCommit(draft: CodingState, change: CommitChange, action: string, detail: string, at: string): boolean {
  const applicable = applyChange(draft, change);
  bumpRevision(draft, at);
  pushAudit(draft, action, detail, at);
  return applicable;
}

/**
 * 根据「当前状态」生成反向变更，用于撤销。
 * 反向记录同样携带真实的前后值，因此连续撤销/重做不会漂移。
 */
export function invertChange(state: CodingState, change: CommitChange): CommitChange {
  switch (change.kind) {
    case 'assignment':
      return { ...change, before: change.after, after: change.before };
    case 'batch-assign':
      return {
        ...change,
        after: !change.after,
        // 撤销时逐条恢复；before 映射在重放时不使用，保留原值用于再次反转（重做）
        before: Object.fromEntries(change.segmentIds.map((id) => [id, !change.after]))
      };
    case 'add-theme':
      // 用当前状态里的真实引用构造删除，确保撤销能完整回滚期间挂到它下面的编码
      {
        const current = state.themes.find((item) => item.id === change.theme.id) ?? change.theme;
        const assignments: Record<CoderId, Record<string, string[]>> = { A: {}, B: {} };
        state.segments.forEach((segment) => {
          (['A', 'B'] as CoderId[]).forEach((coder) => {
            if (segment.assignments[coder].includes(current.id)) assignments[coder][segment.id] = [...segment.assignments[coder]];
          });
        });
        const orphaned = state.themes.filter((theme) => theme.parentId === current.id).map((theme) => ({ id: theme.id, parentId: theme.parentId }));
        return { kind: 'delete-theme', themeId: current.id, theme: structuredClone(current), assignments, orphaned };
      }
    case 'delete-theme':
      // 精确反向：恢复主题及删除时抓拍的全部片段引用
      return { kind: 'restore-theme', theme: structuredClone(change.theme), assignments: structuredClone(change.assignments), orphaned: structuredClone(change.orphaned) };
    case 'restore-theme':
      return { kind: 'delete-theme', themeId: change.theme.id, theme: structuredClone(change.theme), assignments: structuredClone(change.assignments), orphaned: structuredClone(change.orphaned) };
    case 'update-theme':
      return { ...change, before: change.after, after: change.before };
    case 'merge-themes':
      return {
        kind: 'unmerge-themes',
        sourceTheme: structuredClone(change.sourceTheme),
        targetId: change.targetId,
        reparented: [...change.reparented],
        assignmentsBefore: structuredClone(change.assignmentsBefore)
      };
    case 'unmerge-themes':
      // 反向回去即重新合并：unmerge 时抓拍数据等价于一条新的 merge 输入
      return {
        kind: 'merge-themes',
        sourceId: change.sourceTheme.id,
        targetId: change.targetId,
        sourceTheme: structuredClone(change.sourceTheme),
        reparented: [...change.reparented],
        assignmentsBefore: structuredClone(change.assignmentsBefore)
      };
    case 'split-theme':
      return { kind: 'unsplit-theme', sourceId: change.sourceId, theme: structuredClone(change.theme), segmentIds: [...change.segmentIds] };
    case 'unsplit-theme':
      return { kind: 'split-theme', sourceId: change.sourceId, theme: structuredClone(change.theme), segmentIds: [...change.segmentIds] };
    case 'update-segment':
      return { ...change, before: change.after, after: change.before };
    case 'import-transcript':
      return { kind: 'delete-transcript', transcript: structuredClone(change.transcript), segments: structuredClone(change.segments) };
    case 'delete-transcript':
      return { kind: 'import-transcript', transcript: structuredClone(change.transcript), segments: structuredClone(change.segments) };
    case 'add-example': {
      const theme = state.themes.find((item) => item.id === change.themeId);
      // 反向表示「移除该示例」，用 before/after 布尔无法表达；借助 update-theme 恢复整个 examples 数组
      if (!theme) return { kind: 'audit-only' };
      const examplesAfter = [...theme.examples];
      const examplesBefore = examplesAfter.filter((item) => item !== change.example);
      return { kind: 'update-theme', themeId: change.themeId, before: { examples: examplesAfter }, after: { examples: examplesBefore } };
    }
    case 'rename-coder':
      return { ...change, before: change.after, after: change.before };
    case 'audit-only':
      return { kind: 'audit-only' };
    default:
      return { kind: 'audit-only' };
  }
}

/** 一条变更涉及的实体（供界面冲突标记与导出使用） */
export function affectedEntities(change: CommitChange): { themeIds: string[]; segmentIds: string[] } {
  const themeIds = new Set<string>();
  const segmentIds = new Set<string>();
  switch (change.kind) {
    case 'assignment':
      themeIds.add(change.themeId);
      segmentIds.add(change.segmentId);
      break;
    case 'batch-assign':
      themeIds.add(change.themeId);
      change.segmentIds.forEach((id) => segmentIds.add(id));
      break;
    case 'add-theme':
    case 'delete-theme':
    case 'restore-theme':
      if (change.kind === 'add-theme' || change.kind === 'restore-theme') themeIds.add(change.theme.id);
      else {
        themeIds.add(change.themeId);
        Object.values(change.assignments).forEach((map) => Object.keys(map).forEach((id) => segmentIds.add(id)));
      }
      break;
    case 'update-theme':
    case 'add-example':
      themeIds.add(change.themeId);
      break;
    case 'merge-themes':
    case 'unmerge-themes': {
      const sourceId = change.kind === 'merge-themes' ? change.sourceId : change.sourceTheme.id;
      themeIds.add(sourceId);
      themeIds.add(change.targetId);
      if (change.kind === 'unmerge-themes') change.reparented.forEach((id) => themeIds.add(id));
      break;
    }
    case 'split-theme':
    case 'unsplit-theme':
      themeIds.add(change.sourceId);
      themeIds.add(change.theme.id);
      change.segmentIds.forEach((id) => segmentIds.add(id));
      break;
    case 'update-segment':
      segmentIds.add(change.segmentId);
      break;
    case 'import-transcript':
    case 'delete-transcript':
      change.segments.forEach((segment) => segmentIds.add(segment.id));
      break;
    case 'rename-coder':
    case 'audit-only':
      break;
  }
  return { themeIds: [...themeIds], segmentIds: [...segmentIds] };
}

/** 冲突重放的前提检查：在 head 状态上判断该变更是否还能安全应用 */
export function canReapply(state: CodingState, change: CommitChange): boolean {
  switch (change.kind) {
    case 'assignment':
      return !!state.segments.find((segment) => segment.id === change.segmentId) &&
        (!change.after || state.themes.some((theme) => theme.id === change.themeId));
    case 'batch-assign':
      return (!change.after || state.themes.some((theme) => theme.id === change.themeId)) &&
        change.segmentIds.every((id) => state.segments.some((segment) => segment.id === id));
    case 'add-theme':
      // 父主题消失时 applyChange 会降级为一级主题，所以总是可重放
      return true;
    case 'restore-theme':
      // 目标 id 已被他用（例如其他标签新建了同名主题）则不可重放，避免覆盖
      return !state.themes.some((theme) => theme.id === change.theme.id);
    case 'delete-theme':
    case 'update-theme':
    case 'add-example':
      return state.themes.some((theme) => theme.id === change.themeId);
    case 'merge-themes':
      // 目标还在；来源若已被删也幂等可接受
      return state.themes.some((theme) => theme.id === change.targetId) && change.sourceId !== change.targetId;
    case 'unmerge-themes':
      return state.themes.some((theme) => theme.id === change.targetId) &&
        !state.themes.some((theme) => theme.id === change.sourceTheme.id);
    case 'split-theme':
      return state.themes.some((theme) => theme.id === change.sourceId) &&
        !state.themes.some((theme) => theme.id === change.theme.id);
    case 'unsplit-theme':
      return state.themes.some((theme) => theme.id === change.sourceId) &&
        state.themes.some((theme) => theme.id === change.theme.id);
    case 'update-segment':
      return state.segments.some((segment) => segment.id === change.segmentId);
    case 'import-transcript':
    case 'delete-transcript':
      return true;
    case 'rename-coder':
    case 'audit-only':
      return true;
    default:
      return false;
  }
}
