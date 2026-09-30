export type CoderId = 'A' | 'B';

export interface Theme {
  id: string;
  name: string;
  parentId: string | null;
  color: string;
  definition: string;
  memo: string;
  examples: string[];
}

export interface Segment {
  id: string;
  transcriptId: string;
  order: number;
  speaker: string;
  time: string;
  text: string;
  assignments: Record<CoderId, string[]>;
  note: string;
}

export interface Transcript {
  id: string;
  title: string;
  participant: string;
  importedAt: string;
  sourceName: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  detail: string;
}

/** 语义应用提交时发现的对不上情况：引用的主题/片段缺失等 */
export interface ConflictMarker {
  id: string;
  commitId: string;
  kind: 'missing-theme' | 'missing-segment' | 'missing-transcript';
  message: string;
  detectedAt: string;
  resolved: boolean;
}

/**
 * 每次编码改动的可序列化操作。提交日志只保存操作而非整包状态，
 * 重开后按基础修订重放到当前快照上。
 */
export type CodingOperation =
  | { type: 'restore'; snapshot: Omit<CodingState, 'revision' | 'updatedAt' | 'headCommitId'> }
  | { type: 'setCoder'; coder: CoderId; name: string }
  | { type: 'toggleAssignment'; segmentId: string; coder: CoderId; themeId: string; enabled: boolean }
  | { type: 'batchAssign'; segmentIds: string[]; coder: CoderId; themeId: string }
  | { type: 'addTheme'; id: string; name: string; parentId: string | null; color: string }
  | { type: 'updateTheme'; themeId: string; patch: Partial<Theme> }
  | { type: 'deleteTheme'; themeId: string }
  | { type: 'mergeThemes'; sourceId: string; targetId: string }
  | { type: 'splitTheme'; sourceId: string; newId: string; newName: string; segmentIds: string[] }
  | { type: 'updateSegment'; segmentId: string; patch: Pick<Segment, 'speaker' | 'time' | 'text' | 'note'> }
  | { type: 'addExample'; themeId: string; example: string }
  | { type: 'importTranscript'; transcript: Transcript; segments: Segment[] }
  | { type: 'resolveConflict'; markerId: string };

export type CommitStatus = 'pending' | 'conflicted';

/** 待提交记录：先于主题/片段/审计落库，带基础修订 */
export interface PendingCommit {
  id: string;
  baseRevision: number;
  createdAt: string;
  writerId: string;
  writerName: string;
  action: string;
  detail: string;
  operation: CodingOperation;
  status: CommitStatus;
  attempts: number;
  lastError: string | null;
  /** 与其他标签页分叉时记录对方修订，提交仍保留供逐项选择 */
  conflict: { detectedAt: string; currentRevision: number; reasons: string[] } | null;
}

export interface CodingState {
  revision: number;
  updatedAt: string;
  headCommitId: string;
  activeTranscriptId: string;
  activeSegmentId: string;
  activeThemeId: string;
  coderA: string;
  coderB: string;
  transcripts: Transcript[];
  segments: Segment[];
  themes: Theme[];
  audit: AuditEntry[];
  conflicts: ConflictMarker[];
}

export interface PersistedEnvelope {
  revision: number;
  updatedAt: string;
  writerId: string;
  state: CodingState;
}

export interface RemoteHead {
  revision: number;
  updatedAt: string;
  writerId: string;
}

export interface CodingExport extends CodingState {
  exportedAt: string;
  finalRevision: number;
  pendingCommits: Array<Pick<PendingCommit, 'id' | 'baseRevision' | 'createdAt' | 'writerName' | 'action' | 'detail' | 'status' | 'attempts' | 'lastError' | 'conflict'>>;
  unresolvedConflicts: ConflictMarker[];
}
