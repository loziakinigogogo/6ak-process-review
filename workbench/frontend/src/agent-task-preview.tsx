import { useEffect, useRef } from 'react';
import { AlertCircle, Copy, LoaderCircle, X } from 'lucide-react';

export type TaskTarget = { type: string; id: string; label: string };
export type TaskQuote = { text: string; claimId: string; sourceLabel?: string };

type Props = {
  task: string;
  revision: number;
  targets: TaskTarget[];
  materials: TaskTarget[];
  quote?: TaskQuote;
  draft?: string;
  includeDraft: boolean;
  busy: boolean;
  stale: boolean;
  hasMissingTargets: boolean;
  error: string;
  fallback: string;
  onTaskChange: (value: string) => void;
  onIncludeDraft: (value: boolean) => void;
  onRemoveQuote: () => void;
  onRefresh: () => void;
  onCancel: () => void;
  onConfirm: () => void;
};

export function AgentTaskPreview({ task, revision, targets, materials, quote, draft, includeDraft, busy, stale, hasMissingTargets, error, fallback,
  onTaskChange, onIncludeDraft, onRemoveQuote, onRefresh, onCancel, onConfirm }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    headingRef.current?.focus();
    return () => dialog.close();
  }, []);

  useEffect(() => {
    if (!fallback) return;
    fallbackRef.current?.focus();
    fallbackRef.current?.select();
  }, [fallback]);

  return <dialog ref={dialogRef} className="agent-task-dialog" data-testid="agent-task-preview" aria-labelledby="agent-task-heading"
    onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <form onSubmit={event => { event.preventDefault(); onConfirm(); }}>
      <header className="agent-task-header">
        <h2 id="agent-task-heading" ref={headingRef} tabIndex={-1}>交给 Agent</h2>
        <button type="button" className="icon-button" aria-label="关闭任务预览" disabled={busy} onClick={onCancel}><X size={17} /></button>
      </header>

      <div className="agent-task-body">
        <label className="agent-task-label" htmlFor="agent-task-text">这次请 Agent 做什么</label>
        <textarea id="agent-task-text" data-testid="agent-task-text" value={task} disabled={busy} rows={3}
          onChange={event => onTaskChange(event.target.value)} />

        <section className="agent-task-section" aria-labelledby="agent-task-targets-heading" data-testid="agent-task-targets">
          <h3 id="agent-task-targets-heading">处理对象</h3>
          {targets.length ? <ul>{targets.map(target => <li key={`${target.type}:${target.id}`}>{target.label}</li>)}</ul>
            : <p>按任务描述定位对象。</p>}
        </section>

        <section className="agent-task-section" aria-labelledby="agent-task-materials-heading" data-testid="agent-task-materials">
          <h3 id="agent-task-materials-heading">参考材料</h3>
          <p>工作稿 W{revision} 的引用和原文依据</p>
          {!!materials.length && <ul>{materials.map(target => <li key={`${target.type}:${target.id}`}>{target.label}</li>)}</ul>}
          {quote && <div className="agent-task-quote" data-testid="agent-task-quote">
            <div><span>{quote.sourceLabel ? `所选原句 · ${quote.sourceLabel}` : '所选原句'}</span>
              <button type="button" className="agent-task-link" disabled={busy} onClick={onRemoveQuote}>移除选文</button>
            </div>
            <blockquote>{quote.text}</blockquote>
          </div>}
          {draft && <>
            <label className="agent-task-draft-option"><input type="checkbox" checked={includeDraft} disabled={busy}
              onChange={event => onIncludeDraft(event.target.checked)} />附上未保存的输入</label>
            {includeDraft && <pre className="agent-task-draft">{draft}</pre>}
          </>}
        </section>

        {(stale || error) && <div className="agent-task-status" role="alert"><AlertCircle size={16} />
          <div>{error || '工作稿有了新修改。请先重新核对处理对象和参考材料。'}
            {stale && <button className="agent-task-link" type="button" data-testid="refresh-agent-task" disabled={busy} onClick={onRefresh}>
              {hasMissingTargets ? '移除失效对象并重新核对' : '重新核对引用'}
            </button>}
          </div>
        </div>}
        {fallback && <div className="agent-task-fallback">
          <label className="agent-task-label" htmlFor="agent-task-fallback">自动复制失败，请手动复制下方任务</label>
          <textarea ref={fallbackRef} id="agent-task-fallback" data-testid="agent-task-copy-fallback" readOnly rows={5} value={fallback} />
        </div>}
      </div>

      <footer className="agent-task-footer">
        <span>复制到当前任务的 Agent 对话</span>
        <button type="button" className="secondary-button" data-testid="cancel-agent-task" disabled={busy} onClick={onCancel}>取消</button>
        <button className="primary-button" data-testid="confirm-agent-task" disabled={busy || stale || !task.trim()}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <Copy size={15} />}
          {busy ? '正在准备' : '确认并复制'}
        </button>
      </footer>
    </form>
  </dialog>;
}
