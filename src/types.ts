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

/**
 * 一次编码改动。改动以「带前后快照」的记录形式描述，
 * 可以在任意基础修订上重放，也可以反向重放用于撤销。
 */
export type CommitChange =
  | { kind: 'assignment'; segmentId: string; coder: CoderId; themeId: string; before: boolean; after: boolean }
  | { kind: 'batch-assign'; segmentIds: string[]; coder: CoderId; themeId: string; before: Record<string, boolean>; after: boolean }
  | { kind: 'add-theme'; theme: Theme }
  | { kind: 'delete-theme'; themeId: string; theme: Theme; assignments: Record<CoderId, Record<string, string[]>>; orphaned: Array<{ id: string; parentId: string | null }> }
  | { kind: 'restore-theme'; theme: Theme; assignments: Record<CoderId, Record<string, string[]>>; orphaned: Array<{ id: string; parentId: string | null }> }
  | { kind: 'update-theme'; themeId: string; before: Partial<Theme>; after: Partial<Theme> }
  | {
      kind: 'merge-themes';
      sourceId: string;
      targetId: string;
      /** 以下字段在创建记录时抓拍，用于撤销时精确还原 */
      sourceTheme: Theme;
      reparented: string[];
      assignmentsBefore: Record<CoderId, Record<string, string[]>>;
    }
  | { kind: 'unmerge-themes'; sourceTheme: Theme; targetId: string; reparented: string[]; assignmentsBefore: Record<CoderId, Record<string, string[]>> }
  | { kind: 'split-theme'; sourceId: string; theme: Theme; segmentIds: string[] }
  | { kind: 'unsplit-theme'; sourceId: string; theme: Theme; segmentIds: string[] }
  | { kind: 'update-segment'; segmentId: string; before: Pick<Segment, 'speaker' | 'time' | 'text' | 'note'>; after: Pick<Segment, 'speaker' | 'time' | 'text' | 'note'> }
  | { kind: 'import-transcript'; transcript: Transcript; segments: Segment[] }
  | { kind: 'delete-transcript'; transcript: Transcript; segments: Segment[] }
  | { kind: 'add-example'; themeId: string; example: string }
  | { kind: 'rename-coder'; coder: CoderId; before: string; after: string }
  | { kind: 'audit-only' };

export interface CodingState {
  revision: number;
  updatedAt: string;
  activeTranscriptId: string;
  activeSegmentId: string;
  activeThemeId: string;
  coderA: string;
  coderB: string;
  transcripts: Transcript[];
  segments: Segment[];
  themes: Theme[];
  audit: AuditEntry[];
}

/** 待提交记录的生命周期：已落盘待提交 → 已提交（被删除）/ 冲突 / 失败待重试 */
export type PendingStatus = 'queued' | 'conflicted' | 'error';

export interface PendingCommit {
  id: string;
  /** 该记录基于的已提交修订；与当前 head 不一致时不会覆盖写入，而是标记冲突 */
  baseRevision: number;
  createdAt: string;
  writerId: string;
  writerLabel: string;
  action: string;
  detail: string;
  change: CommitChange;
  status: PendingStatus;
  /** 最近一次提交尝试时间，用于判断僵死认领 */
  attemptedAt: string;
  attempts: number;
  lastError?: string;
  /** 标记冲突后记录下当前 head 修订，供界面提示 */
  headRevision?: number;
  /** 仅内存存在、尚未 durable 到 IndexedDB 的记录（落盘失败时为 false） */
  persisted?: boolean;
}

export interface PersistedEnvelope {
  revision: number;
  updatedAt: string;
  writerId: string;
  state: CodingState;
}

/** BroadcastChannel 载荷：只通知「有新提交」，接收方自行从 IndexedDB 读取，避免消息体陈旧 */
export interface ChannelNotice {
  type: 'committed' | 'pending';
  revision: number;
  writerId: string;
  commitId: string;
  at: string;
}

/** 导出 JSON 中的未完成提交视图 */
export interface ExportedPendingCommit {
  id: string;
  status: PendingStatus;
  baseRevision: number;
  headRevision?: number;
  createdAt: string;
  writerId: string;
  writerLabel: string;
  action: string;
  detail: string;
  attempts: number;
  lastError?: string;
  affected: { themeIds: string[]; segmentIds: string[] };
}
