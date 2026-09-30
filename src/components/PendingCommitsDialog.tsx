import { For, Show } from 'solid-js';
import { Button } from '@suid/material';
import type { PendingCommit } from '../types';
import type { useCodingStore } from '../store/coding-store';
import { affectedEntities } from '../store/engine';

type Store = ReturnType<typeof useCodingStore>;

const STATUS_LABEL: Record<PendingCommit['status'], string> = {
  queued: '提交中',
  conflicted: '修订冲突',
  error: '写入失败'
};

const formatTime = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

function CommitRow(props: { record: PendingCommit; store: Store }) {
  const affected = () => affectedEntities(props.record.change);
  const themeNames = () => affected().themeIds
    .map((id) => props.store.state.themes.find((theme) => theme.id === id)?.name)
    .filter(Boolean)
    .join('、');
  return (
    <div class={`pending-item ${props.record.status}`}>
      <div class="pending-item-head">
        <span class={`pending-badge ${props.record.status}`}>{STATUS_LABEL[props.record.status]}</span>
        <strong>{props.record.action}</strong>
        <span class="pending-meta">{formatTime(props.record.createdAt)} · {props.record.writerLabel}</span>
      </div>
      <p class="pending-detail">{props.record.detail}</p>
      <div class="pending-meta-line">
        <span>基础修订 r{props.record.baseRevision}</span>
        <Show when={props.record.headRevision !== undefined}>
          <span>对方已推进到 r{props.record.headRevision}</span>
        </Show>
        <Show when={props.record.attempts > 0}><span>已尝试 {props.record.attempts} 次</span></Show>
        <Show when={affected().segmentIds.length}><span>影响片段 {affected().segmentIds.length} 条</span></Show>
        <Show when={themeNames()}><span>主题：{themeNames()}</span></Show>
      </div>
      <Show when={props.record.lastError}><p class="pending-error">{props.record.lastError}</p></Show>
      <div class="pending-actions">
        <Show when={props.record.status === 'error'}>
          <Button size="small" variant="contained" onClick={() => props.store.retryCommit(props.record.id)}>恢复重试</Button>
        </Show>
        <Show when={props.record.status === 'conflicted'}>
          <Button size="small" variant="contained" onClick={() => props.store.reapplyCommit(props.record.id)}>在最新修订上重放</Button>
          <Button size="small" color="warning" variant="outlined" onClick={() => props.store.discardCommit(props.record.id)}>放弃此提交</Button>
        </Show>
        <Show when={props.record.status === 'queued'}>
          <span class="pending-hint">正在等待提交，崩溃或关闭后会自动恢复重试…</span>
        </Show>
      </div>
    </div>
  );
}

export default function PendingCommitsDialog(props: { store: Store; open: boolean; onClose: () => void }) {
  const records = () => [...props.store.pendingCommits()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const groups = () => {
    const list = records();
    return [
      { key: 'error' as const, title: '写入失败 · 可恢复重试', items: list.filter((item) => item.status === 'error') },
      { key: 'conflicted' as const, title: '修订冲突 · 请逐项选择，双方内容都不会被覆盖', items: list.filter((item) => item.status === 'conflicted') },
      { key: 'queued' as const, title: '待提交 · 已先写入本地恢复记录', items: list.filter((item) => item.status === 'queued') }
    ];
  };

  return (
    <div class="modal-backdrop" classList={{ hidden: !props.open }} onClick={props.onClose}>
      <section class="modal-card wide pending-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <header>
          <div><span class="eyebrow">OUTBOX / WAL</span><h2>未完成提交与冲突</h2></div>
          <button class="modal-close" onClick={props.onClose}>×</button>
        </header>
        <p class="modal-intro">
          每一次编码改动都先作为「带基础修订的待提交记录」落盘，成功提交后才清除。另一标签页先提交时，本页记录会保留在此供研究者逐项选择；
          写入失败的记录也会保留，刷新或重开浏览器后可继续重试。当前已提交最终修订：<strong>r{props.store.state.revision}</strong>。
        </p>
        <Show when={props.store.errorCount() > 0}>
          <div class="pending-toolbar">
            <Button size="small" variant="contained" onClick={props.store.retryAll}>全部恢复重试</Button>
          </div>
        </Show>
        <div class="pending-groups">
          <For each={groups()}>
            {(group) => (
              <Show when={group.items.length}>
                <div class="pending-group">
                  <h4>{group.title}<span>{group.items.length}</span></h4>
                  <For each={group.items}>{(record) => <CommitRow record={record} store={props.store} />}</For>
                </div>
              </Show>
            )}
          </For>
          <Show when={!records().length}>
            <div class="empty-state">没有未完成提交，所有编码改动都已安全写入本地数据库。</div>
          </Show>
        </div>
      </section>
    </div>
  );
}
