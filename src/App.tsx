import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { AppBar, Button, Chip, Paper, Toolbar, Typography } from '@suid/material';
import TranscriptPanel from './components/TranscriptPanel';
import ThemeTree from './components/ThemeTree';
import Inspector from './components/Inspector';
import ImportDialog from './components/ImportDialog';
import { CreateThemeDialog, MergeThemeDialog, SplitThemeDialog } from './components/ThemeDialogs';
import { useCodingStore } from './store/coding-store';

export default function App() {
  const store = useCodingStore();
  const [importOpen, setImportOpen] = createSignal(false);
  const [createOpen, setCreateOpen] = createSignal(false);
  const [createParent, setCreateParent] = createSignal<string | undefined>();
  const [mergeOpen, setMergeOpen] = createSignal(false);
  const [splitOpen, setSplitOpen] = createSignal(false);
  const [shortcutsOpen, setShortcutsOpen] = createSignal(false);

  const activeSegments = createMemo(() => store.state.segments
    .filter((segment) => segment.transcriptId === store.state.activeTranscriptId)
    .sort((a, b) => a.order - b.order));

  const moveSegment = (delta: number) => {
    const segments = activeSegments();
    const index = segments.findIndex((segment) => segment.id === store.state.activeSegmentId);
    const next = segments[Math.max(0, Math.min(segments.length - 1, index + delta))];
    if (next) {
      store.selectSegment(next.id);
      document.querySelector('.segment-card.active')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  const handleKeys = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    const editing = /INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? store.redo() : store.undo();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      store.redo();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      store.downloadExport('json');
      return;
    }
    if (editing) return;
    if (event.key.toLowerCase() === 'j') { event.preventDefault(); moveSegment(1); }
    if (event.key.toLowerCase() === 'k') { event.preventDefault(); moveSegment(-1); }
    if (event.key === '/') {
      event.preventDefault();
      document.querySelector<HTMLInputElement>('.transcript-panel .native-input')?.focus();
    }
    if (event.key === '?') setShortcutsOpen((open) => !open);
    if (/^[1-9]$/.test(event.key)) {
      const theme = store.orderedThemes()[Number(event.key) - 1];
      if (theme) store.selectTheme(theme.id);
    }
    if (event.altKey && event.key.toLowerCase() === 'a' && store.state.activeThemeId) {
      event.preventDefault();
      store.toggleAssignment(store.state.activeSegmentId, 'A', store.state.activeThemeId, true);
    }
    if (event.altKey && event.key.toLowerCase() === 'b' && store.state.activeThemeId) {
      event.preventDefault();
      store.toggleAssignment(store.state.activeSegmentId, 'B', store.state.activeThemeId, true);
    }
  };

  onMount(() => {
    void store.initialize();
    window.addEventListener('keydown', handleKeys);
  });
  onCleanup(() => window.removeEventListener('keydown', handleKeys));

  return (
    <div class="app-shell">
      <AppBar position="static" class="topbar">
        <Toolbar class="toolbar">
          <div class="brand">
            <div class="brand-mark">码</div>
            <div><Typography variant="h6" component="div">访谈主题编码台</Typography><span>INTERPRETIVE CODING WORKBENCH</span></div>
          </div>
          <div class="top-actions">
            <div class="save-state">
              <span classList={{ pulsing: !store.storageReady() || store.pendingCommits().length > 0, error: !!store.writeError(), warn: store.conflictedCommits().length > 0 }} />
              {store.writeError()
                ? `写入失败 · ${store.pendingCommits().length} 条待提交将自动重试`
                : store.conflictedCommits().length
                  ? `其他标签有更新 · ${store.conflictedCommits().length} 条提交待选择`
                  : store.pendingCommits().length
                    ? `正在提交 · ${store.pendingCommits().length} 条待提交`
                    : store.storageReady() ? `已保存 · 最终修订 r${store.state.revision}` : '正在恢复本地库'}
            </div>
            <Button color="inherit" size="small" disabled={!store.canUndo()} onClick={store.undo}>撤销</Button>
            <Button color="inherit" size="small" disabled={!store.canRedo()} onClick={store.redo}>重做</Button>
            <Button variant="outlined" color="inherit" size="small" onClick={() => setImportOpen(true)}>导入转写</Button>
            <Button variant="contained" color="secondary" size="small" onClick={() => store.downloadExport('json')}>导出编码</Button>
          </div>
        </Toolbar>
      </AppBar>

      <Show when={store.writeError()}>
        <div class="error-banner" role="alert">
          <div>
            <strong>本地数据库写入失败，改动没有丢失</strong>
            <span>每次改动都已先记为带基础修订的待提交记录；将按退避自动重试，也可立即重试。</span>
          </div>
          <div>
            <Button size="small" variant="contained" color="inherit" onClick={store.retryAll}>立即重试全部</Button>
          </div>
        </div>
      </Show>

      <Show when={store.conflictedCommits().length > 0}>
        <div class="conflict-banner" role="alert">
          <div>
            <strong>另一个标签页已提交更新（r{store.conflictedCommits()[0].conflict?.currentRevision ?? store.state.revision}），本页提交已逐项保留</strong>
            <span>系统没有覆盖任何一方。请先载入其他标签页版本作为基础，再对下面每条本页提交选择“重放到新版本”或“放弃”。</span>
          </div>
          <div>
            <Button size="small" color="inherit" onClick={() => void store.adoptRemote()}>载入其他标签页版本</Button>
          </div>
        </div>
      </Show>

      <Show when={store.pendingCommits().length > 0}>
        <section class="pending-panel" aria-label="未完成提交">
          <div class="pending-heading">
            <div>
              <span class="eyebrow">PENDING COMMITS</span>
              <h3>待提交记录（先于快照落库，崩溃后自动恢复）</h3>
            </div>
            <Button size="small" variant="outlined" onClick={store.retryAll}>重试全部待提交</Button>
          </div>
          <div class="pending-list">
            <For each={store.pendingCommits()}>{(commit) => (
              <div class="pending-item" classList={{ conflicted: commit.status === 'conflicted' }}>
                <div class="pending-main">
                  <strong>{commit.action}</strong>
                  <p>{commit.detail}</p>
                  <div class="pending-meta">
                    <span>基础修订 r{commit.baseRevision}</span>
                    <span>{commit.writerName}</span>
                    <span>{new Date(commit.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                    <Show when={commit.attempts > 0}><span>已尝试 {commit.attempts} 次</span></Show>
                  </div>
                  <Show when={commit.conflict}>
                    <div class="pending-conflict">
                      其他标签页已推进到 r{commit.conflict!.currentRevision}。
                      <Show when={commit.conflict!.reasons.length} fallback={<span>该提交与新版本无直接引用冲突。</span>}>
                        <ul><For each={commit.conflict!.reasons}>{(reason) => <li>{reason}</li>}</For></ul>
                      </Show>
                    </div>
                  </Show>
                  <Show when={commit.lastError}><div class="pending-error">写入失败：{commit.lastError}</div></Show>
                </div>
                <div class="pending-actions">
                  <Show
                    when={commit.status === 'conflicted'}
                    fallback={<span class="pending-status queued">排队提交中…</span>}
                  >
                    <Button size="small" variant="contained" onClick={() => store.rebaseCommit(commit.id)}>重放到新版本</Button>
                    <Button size="small" variant="outlined" color="error" onClick={() => store.discardCommit(commit.id)}>放弃此提交</Button>
                  </Show>
                </div>
              </div>
            )}</For>
          </div>
        </section>
      </Show>

      <Show when={store.unresolvedMarkers().length > 0}>
        <section class="marker-panel" aria-label="数据冲突标记">
          <div class="pending-heading">
            <div>
              <span class="eyebrow">CONFLICT MARKERS</span>
              <h3>主题树、片段判断或审计与提交记录对不上（{store.unresolvedMarkers().length}）</h3>
            </div>
          </div>
          <div class="marker-list">
            <For each={store.unresolvedMarkers()}>{(marker) => (
              <div class="marker-item">
                <div>
                  <strong>{marker.kind === 'missing-theme' ? '主题缺失' : marker.kind === 'missing-segment' ? '片段缺失' : '转写缺失'}</strong>
                  <p>{marker.message}</p>
                  <span>{new Date(marker.detectedAt).toLocaleString('zh-CN')}</span>
                </div>
                <Button size="small" variant="outlined" onClick={() => store.resolveConflictMarker(marker.id)}>已复核，标记解决</Button>
              </div>
            )}</For>
          </div>
        </section>
      </Show>

      <section class="project-strip">
        <div><span class="eyebrow">CODING PROJECT</span><h1>{store.state.transcripts.find((item) => item.id === store.state.activeTranscriptId)?.title ?? '访谈语料库'}</h1></div>
        <div class="project-metrics">
          <div><strong>{store.state.segments.length}</strong><span>转写片段</span></div>
          <div><strong>{store.state.themes.length}</strong><span>层级主题</span></div>
          <div><strong>{store.state.segments.filter((segment) => segment.assignments.A.join('|') !== segment.assignments.B.join('|')).length}</strong><span>编码分歧</span></div>
          <div><strong>{store.state.revision}</strong><span>最终修订</span></div>
        </div>
      </section>

      <main class="workspace-grid">
        <TranscriptPanel store={store} />
        <ThemeTree store={store} onCreate={(parentId) => { setCreateParent(parentId); setCreateOpen(true); }} onMerge={() => setMergeOpen(true)} onSplit={() => setSplitOpen(true)} />
        <Inspector store={store} />
      </main>

      <section class="lower-grid">
        <Paper class="panel codebook-panel" elevation={0}>
          <div class="panel-heading"><div><span class="eyebrow">CODEBOOK HEALTH</span><h3>编码册质量检查</h3></div><Chip label="实时" size="small" /></div>
          <div class="health-grid">
            <div class="health-item"><strong>{store.state.segments.filter((segment) => !segment.assignments.A.length && !segment.assignments.B.length).length}</strong><span>未编码片段</span><small>可批量选择后重新编码</small></div>
            <div class="health-item"><strong>{store.state.themes.filter((theme) => !theme.definition).length}</strong><span>缺少定义的主题</span><small>定义会帮助后续编码保持一致</small></div>
            <div class="health-item"><strong>{store.state.segments.filter((segment) => segment.assignments.A.join('|') !== segment.assignments.B.join('|')).length}</strong><span>双编码分歧</span><small>使用双人比较逐条处理</small></div>
          </div>
        </Paper>
        <Paper class="panel export-panel" elevation={0}>
          <div class="panel-heading"><div><span class="eyebrow">EXPORT & BACKUP</span><h3>研究数据出口</h3></div></div>
          <p>导出包含完整主题路径、双编码者判断、备忘录、主题示例、审计记录、最终修订与全部未完成提交（含分叉原因和写入错误）。CSV 适合表格复核，JSON 可完整回档。</p>
          <div class="button-row"><Button variant="contained" onClick={() => store.downloadExport('json')}>下载 JSON 完整包</Button><Button variant="outlined" onClick={() => store.downloadExport('csv')}>下载 CSV 编码表</Button></div>
        </Paper>
      </section>

      <footer class="app-footer">
        <span>快捷键 J / K 切换片段 · 1–9 选择主题 · Alt+A / Alt+B 编码 · Ctrl+Z 撤销 · ? 查看帮助</span>
        <span>IndexedDB 本地保存 · 写前日志先落库 · 多标签页提交逐项保留不覆盖</span>
      </footer>

      <ImportDialog open={importOpen()} onClose={() => setImportOpen(false)} onImport={store.importTranscript} />
      <CreateThemeDialog store={store} open={createOpen()} parentId={createParent()} onClose={() => { setCreateOpen(false); setCreateParent(undefined); }} />
      <MergeThemeDialog store={store} open={mergeOpen()} onClose={() => setMergeOpen(false)} />
      <SplitThemeDialog store={store} open={splitOpen()} onClose={() => setSplitOpen(false)} />

      <div class="modal-backdrop" classList={{ hidden: !shortcutsOpen() }} onClick={() => setShortcutsOpen(false)}>
        <section class="modal-card" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
          <header><div><span class="eyebrow">KEYBOARD</span><h2>键盘操作</h2></div><button class="modal-close" onClick={() => setShortcutsOpen(false)}>×</button></header>
          <div class="shortcut-list">
            <For each={[['J / K', '下一条 / 上一条片段'], ['1–9', '选择主题树中的主题'], ['Alt+A / Alt+B', '将当前主题分配给编码者'], ['/', '聚焦正文搜索'], ['Ctrl+Z / Ctrl+Y', '撤销 / 重做'], ['Ctrl+E', '导出 JSON'], ['?', '显示或隐藏此面板']]}>{([key, text]) => <div><kbd>{key}</kbd><span>{text}</span></div>}</For>
          </div>
        </section>
      </div>
    </div>
  );
}
