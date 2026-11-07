import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  Show,
} from 'solid-js';
import { IconButton, Modal } from '../ui/primitives';
import { Icon } from '../ui/Icon';
import { MessageBody } from './MessageBody';
import { ProviderLogo } from '../ui/ProviderLogo';
import { type AgentWorkspace } from './workspace';
import { AgentChatMenus } from './AgentMenus';
import { imageMime } from '../../domain/images';
import type { AgentTurn } from '../../contracts/agent';
import { AgentAttachmentCard } from './AgentAttachmentCard';
export { AgentConnections } from './AgentConnections';

const questionFieldId = (questionId: string, fieldKey: string) =>
  `agent-question-${encodeURIComponent(questionId)}-${encodeURIComponent(fieldKey)}`;
const attachedPaths = (turn: AgentTurn) =>
  turn.attachments ?? turn.images?.map((image) => image.path) ?? [];

export function AgentChats(props: {
  agent: AgentWorkspace;
  onConnect: () => void;
  onNewChat: () => void;
  onSelect?: () => void;
}) {
  const a = props.agent;
  const [deleting, setDeleting] = createSignal<{ id: string; title: string } | null>(null);
  const [renaming, setRenaming] = createSignal<{ id: string } | null>(null);
  const [chatName, setChatName] = createSignal('');
  const [renameError, setRenameError] = createSignal('');
  const renameErrorId = createUniqueId();
  let chats!: HTMLDivElement;
  const closeRename = () => {
    if (a.busy()) return;
    const id = renaming()?.id;
    setRenaming(null);
    if (id)
      requestAnimationFrame(() =>
        chats
          .querySelector<HTMLButtonElement>(
            `[data-chat-id="${CSS.escape(id)}"] .agent-chat-actions button`,
          )
          ?.focus(),
      );
  };
  return (
    <div class="agent-chats" ref={chats}>
      <Show
        when={a.state()?.sessions.length}
        fallback={
          <div class="sidebar-empty chat-empty">
            <Icon name="chat" size={24} />
            <p>No conversations yet</p>
            <span>Ask about your paper or work on a revision together.</span>
            <button
              class="text-button"
              disabled={a.busy() || !!a.state()?.running}
              onClick={props.onNewChat}
            >
              New conversation
            </button>
          </div>
        }
      >
        <ul class="agent-chat-list">
          <For each={a.state()?.sessions}>
            {(ref) => (
              <li data-chat-id={ref.id}>
                <button
                  class="agent-chat-row"
                  classList={{ selected: a.state()?.sessionId === ref.id }}
                  aria-pressed={a.state()?.sessionId === ref.id}
                  disabled={
                    a.busy() || (a.state()?.running && a.state()?.connection === 'connected')
                  }
                  onClick={() => {
                    void a.selectChat(ref.id).then((ok) => {
                      if (ok) props.onSelect?.();
                    });
                  }}
                >
                  <ProviderLogo provider={ref.harness} size={20} />
                  <span class="agent-chat-label">
                    <span class="agent-chat-title" title={ref.title}>
                      {ref.title}
                    </span>
                    <small>
                      {(ref.harnesses ?? [ref.harness])
                        .map((kind) => (kind === 'codex' ? 'Codex' : 'OpenCode'))
                        .join(' · ')}
                    </small>
                  </span>
                </button>
                <div class="agent-chat-actions">
                  <IconButton
                    icon="edit"
                    label={`Rename conversation ${ref.title}`}
                    disabled={a.busy() || !!a.state()?.running}
                    onClick={() => {
                      setChatName(ref.title);
                      setRenameError('');
                      setRenaming({ id: ref.id });
                    }}
                  />
                  <IconButton
                    icon="trash"
                    label={`Delete conversation ${ref.title}`}
                    disabled={a.busy() || !!a.state()?.running}
                    onClick={() => setDeleting({ id: ref.id, title: ref.title })}
                  />
                </div>
              </li>
            )}
          </For>
        </ul>
        <button class="text-button" onClick={props.onConnect}>
          Agent connections
        </button>
      </Show>
      <Modal
        open={!!renaming()}
        title="Rename conversation"
        icon="edit"
        initialFocus="input"
        onClose={closeRename}
      >
        <form
          noValidate
          aria-busy={a.busy()}
          onSubmit={async (event) => {
            event.preventDefault();
            if (a.busy()) return;
            const title = chatName().trim();
            if (!title || title.length > 300) {
              setRenameError('Use a chat name between 1 and 300 characters.');
              event.currentTarget.querySelector('input')?.focus();
              return;
            }
            const projectId = a.projects.project()?.id;
            const target = renaming();
            if (!projectId || !target) return;
            const result = await a.act({
              type: 'rename-session',
              projectId,
              sessionId: target.id,
              title,
            });
            if (result) closeRename();
            else setRenameError(a.error() || 'The chat name could not be saved. Try again.');
          }}
        >
          <label class="form-field">
            Chat name
            <input
              value={chatName()}
              onFocus={(event) => event.currentTarget.select()}
              maxLength={300}
              disabled={a.busy()}
              aria-invalid={!!renameError()}
              aria-describedby={renameError() ? renameErrorId : undefined}
              onInput={(event) => {
                setChatName(event.currentTarget.value);
                setRenameError('');
              }}
            />
          </label>
          <Show when={renameError()}>
            <p id={renameErrorId} class="inline-error" role="alert">
              {renameError()}
            </p>
          </Show>
          <div class="modal-actions">
            <button
              type="button"
              class="secondary-button"
              disabled={a.busy()}
              onClick={closeRename}
            >
              Cancel
            </button>
            <button type="submit" class="primary-button" disabled={a.busy()}>
              Save name
            </button>
          </div>
        </form>
      </Modal>
      <Modal
        open={!!deleting()}
        title="Delete conversation"
        icon="trash"
        onClose={() => {
          if (!a.busy()) setDeleting(null);
        }}
      >
        <p>
          Delete “{deleting()?.title}” from Loom on this computer? Paper files and change-recovery
          records stay intact. Native agent history stays in its harness.
        </p>
        <div class="button-row">
          <button class="secondary-button" disabled={a.busy()} onClick={() => setDeleting(null)}>
            Cancel
          </button>
          <button
            class="primary-button"
            disabled={a.busy()}
            onClick={async () => {
              const projectId = a.projects.project()?.id;
              if (
                projectId &&
                deleting() &&
                (await a.act({ type: 'delete-session', projectId, sessionId: deleting()!.id }))
              ) {
                setDeleting(null);
                requestAnimationFrame(() =>
                  chats
                    .querySelector<HTMLButtonElement>(
                      '.agent-chat-row:not(:disabled), .chat-empty button',
                    )
                    ?.focus(),
                );
              }
            }}
          >
            Delete conversation
          </button>
        </div>
        <Show when={a.error()}>
          <p role="alert" class="inline-error">
            {a.error()}
          </p>
        </Show>
      </Modal>
    </div>
  );
}
export function AgentConversation(props: { agent: AgentWorkspace; onNewChat: () => void }) {
  const a = props.agent;
  const earlierAttachments = createMemo(() =>
    a
      .state()
      ?.turns.filter(
        (turn) =>
          turn.conversationId === a.state()?.sessionId &&
          attachedPaths(turn).length &&
          !turn.messageId &&
          !turn.messageAssociationResolved &&
          turn.status !== 'running',
      ),
  );
  let scroller!: HTMLDivElement;
  const [copyError, setCopyError] = createSignal('');
  const [copiedMessage, setCopiedMessage] = createSignal('');
  let copyFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(copyFeedbackTimer));
  const copyMessage = async (id: string, text: string) => {
    try {
      const clipboard = navigator.clipboard;
      if (!clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
      await clipboard.writeText(text);
      setCopyError('');
      setCopiedMessage(id);
      clearTimeout(copyFeedbackTimer);
      copyFeedbackTimer = setTimeout(() => setCopiedMessage(''), 1800);
    } catch {
      setCopiedMessage('');
      setCopyError('Could not copy this message. Select its text and copy it instead.');
    }
  };
  const [follow, setFollow] = createSignal(true),
    [questionErrors, setQuestionErrors] = createSignal<
      Record<string, { message: string; fieldId: string }>
    >({}),
    [answers, setAnswers] = createSignal<
      Record<string, Record<string, string | string[] | boolean>>
    >({});
  const clearQuestionError = (questionId: string, fieldId: string) => {
    setQuestionErrors((old) => {
      if (old[questionId]?.fieldId !== fieldId) return old;
      const next = { ...old };
      delete next[questionId];
      return next;
    });
  };
  const updateQuestionAnswer = (
    questionId: string,
    fieldId: string,
    fieldKey: string,
    value: string | string[] | boolean,
  ) => {
    setAnswers((old) => ({
      ...old,
      [questionId]: { ...old[questionId], [fieldKey]: value },
    }));
    clearQuestionError(questionId, fieldId);
  };
  const content = createMemo(
    () =>
      a
        .state()
        ?.messages.map((m) => m.id + m.text + m.state)
        .join('|') +
      JSON.stringify(a.state()?.permissions) +
      JSON.stringify(a.state()?.questions),
  );
  createEffect(() => {
    content();
    if (follow())
      requestAnimationFrame(() => {
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      });
  });
  return (
    <Show when={a.open()}>
      <section class="agent-conversation" aria-label="Conversation about this paper">
        <div class="agent-conversation-heading">
          <IconButton
            icon="down"
            label="Hide conversation"
            onClick={() => {
              a.setOpen(false);
              requestAnimationFrame(() =>
                document.querySelector<HTMLTextAreaElement>('.agent-prompt')?.focus(),
              );
            }}
          />
          <span>
            {a.state()?.sessions.find((s) => s.id === a.state()?.sessionId)?.title ??
              'New conversation'}
          </span>
          <div>
            <IconButton
              icon="plus"
              label="New conversation"
              disabled={a.busy() || !!a.state()?.running}
              onClick={props.onNewChat}
            />
          </div>
        </div>
        <div
          class="agent-messages"
          ref={scroller}
          onScroll={() =>
            setFollow(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60)
          }
        >
          <Show
            when={a.state()?.messages.length}
            fallback={
              <p class="agent-chat-guidance">
                Ask where an assumption enters your paper, discuss an idea, or request a focused
                revision. The agent can inspect relevant project files.
              </p>
            }
          >
            <For each={a.state()?.messages}>
              {(message) => (
                <div
                  class="agent-message"
                  classList={{
                    'agent-message-user': message.role === 'user',
                    'agent-message-tool': message.role === 'tool',
                    'agent-message-status': message.role === 'status',
                    'agent-message-harness': message.role === 'assistant',
                  }}
                >
                  <small>
                    <Show
                      when={message.role === 'assistant'}
                      fallback={
                        <Icon
                          name={
                            message.role === 'user'
                              ? 'user'
                              : message.role === 'tool'
                                ? 'terminal'
                                : 'info'
                          }
                          size={13}
                        />
                      }
                    >
                      <ProviderLogo
                        provider={message.harness ?? a.state()?.harness ?? 'opencode'}
                        size={17}
                      />
                    </Show>
                    {message.role === 'user'
                      ? 'You'
                      : message.role === 'assistant'
                        ? (message.harness ?? a.state()?.harness) === 'codex'
                          ? 'Codex'
                          : 'OpenCode'
                        : message.role === 'tool'
                          ? 'Tool activity'
                          : 'Request status'}
                    {message.state ? ' · ' + message.state : ''}
                  </small>
                  <Show when={message.role === 'user'}>
                    <For
                      each={a
                        .state()
                        ?.turns.filter(
                          (turn) =>
                            turn.conversationId === a.state()?.sessionId &&
                            turn.messageId === message.id,
                        )}
                    >
                      {(turn) => <AgentTurnAttachments agent={a} turn={turn} />}
                    </For>
                  </Show>
                  <MessageBody text={message.text} />
                  <Show when={message.execution}>
                    {(execution) => (
                      <details
                        class="agent-execution"
                        onToggle={(event) => {
                          if (!event.currentTarget.open) return;
                          const details = event.currentTarget;
                          requestAnimationFrame(() => {
                            const container = details.closest<HTMLElement>('.agent-messages');
                            if (container)
                              container.scrollTop += Math.max(
                                0,
                                details.getBoundingClientRect().bottom -
                                  container.getBoundingClientRect().bottom +
                                  8,
                              );
                          });
                        }}
                      >
                        <summary>Native command details</summary>
                        <small>
                          Files read by this command may not be shown. Ask the agent to identify the
                          inputs used.
                        </small>
                        <strong>Command</strong>
                        <pre>{execution().command}</pre>
                        <strong>
                          Output{' '}
                          {execution().exitCode !== null ? `· exit ${execution().exitCode}` : ''}
                        </strong>
                        <pre>{execution().output ?? 'No output reported by the harness.'}</pre>
                        <Show when={execution().truncated}>
                          <small>Output or command was truncated for display.</small>
                        </Show>
                      </details>
                    )}
                  </Show>
                  <Show when={message.role === 'assistant' || message.role === 'user'}>
                    <IconButton
                      icon={copiedMessage() === message.id ? 'check' : 'copy'}
                      label={copiedMessage() === message.id ? 'Message copied' : 'Copy message'}
                      onClick={() => void copyMessage(message.id, message.text)}
                    />
                    <span class="agent-copy-status" role="status" aria-live="polite">
                      {copiedMessage() === message.id ? 'Copied' : ''}
                    </span>
                  </Show>
                </div>
              )}
            </For>
          </Show>
          <Show when={earlierAttachments()?.length}>
            <section class="agent-earlier-attachments" aria-label="Earlier request attachments">
              <h4>Earlier attachments</h4>
              <p>Saved with earlier requests in this conversation.</p>
              <For each={earlierAttachments()?.slice().reverse()}>
                {(turn) => (
                  <div>
                    <time dateTime={turn.startedAt}>
                      {new Date(turn.startedAt).toLocaleString()}
                    </time>
                    <AgentTurnAttachments agent={a} turn={turn} compact />
                  </div>
                )}
              </For>
            </section>
          </Show>
          <Show when={copyError()}>
            <p role="alert" class="agent-inline-error">
              {copyError()}
            </p>
          </Show>
          <Show when={a.state()?.running}>
            <p
              class="agent-activity"
              classList={{
                'is-working':
                  a.state()?.connection === 'connected' &&
                  !a.state()?.permissions.length &&
                  !a.state()?.questions.length &&
                  !a.state()?.error,
              }}
              role="status"
            >
              {a.state()?.connection !== 'connected'
                ? 'Connection interrupted · work is retained'
                : a.state()?.error
                  ? 'Checking agent status…'
                  : a.state()?.permissions.length
                    ? 'Waiting for your permission'
                    : a.state()?.questions.length
                      ? 'Waiting for your answer'
                      : 'Thinking…'}
            </p>
          </Show>
          <For each={a.state()?.permissions}>
            {(permission) => (
              <div class="agent-request">
                <h4>Permission needed: {permission.action}</h4>
                <pre>{permission.resources.join('\n')}</pre>
                <p>
                  Allow this operation once using the agent’s permission system. Read the requested
                  action and paths above before allowing it.
                </p>
                <div class="button-row">
                  <button
                    class="secondary-button"
                    disabled={a.busy()}
                    onClick={() => {
                      const projectId = a.projects.project()?.id;
                      if (projectId)
                        void a.act({
                          type: 'permission',
                          projectId,
                          requestId: permission.id,
                          reply: 'reject',
                        });
                    }}
                  >
                    Deny
                  </button>
                  <button
                    class="primary-button"
                    disabled={a.busy()}
                    onClick={() => {
                      const projectId = a.projects.project()?.id;
                      if (projectId)
                        void a.act({
                          type: 'permission',
                          projectId,
                          requestId: permission.id,
                          reply: 'once',
                        });
                    }}
                  >
                    Allow once
                  </button>
                </div>
              </div>
            )}
          </For>
          <For each={a.state()?.questions}>
            {(question) => (
              <form
                noValidate
                class="agent-request"
                onSubmit={(e) => {
                  e.preventDefault();
                  const rawValues: Record<string, string | string[] | boolean | undefined> = {
                    ...Object.fromEntries(
                      question.fields
                        .filter((f) => f.type === 'boolean')
                        .map((f) => [f.key, false]),
                    ),
                    ...(answers()[question.id] ?? {}),
                  };
                  const isEmpty = (value: string | string[] | boolean | undefined) =>
                    value === undefined ||
                    (typeof value === 'string' && value.trim() === '') ||
                    (Array.isArray(value) && value.length === 0);
                  const invalid = question.fields.find((field) => {
                    if (field.type === 'external') return true;
                    if (field.type === 'boolean') return false;
                    const value = rawValues[field.key];
                    const empty = isEmpty(value);
                    if (field.required && empty) return true;
                    if ((field.type === 'number' || field.type === 'integer') && !empty) {
                      const number = Number(value);
                      return (
                        !Number.isFinite(number) ||
                        (field.type === 'integer' && !Number.isInteger(number))
                      );
                    }
                    return false;
                  });
                  if (invalid) {
                    const value = rawValues[invalid.key];
                    const empty = isEmpty(value);
                    const label = invalid.title || invalid.key;
                    const message =
                      invalid.type === 'external'
                        ? `${label} needs an answer in the harness because Loom cannot display this control.`
                        : !empty && (invalid.type === 'number' || invalid.type === 'integer')
                          ? !Number.isFinite(Number(value))
                            ? `Enter a finite number for ${label}.`
                            : `Enter a whole number for ${label}.`
                          : `Answer ${label} before sending.`;
                    const fieldId = questionFieldId(question.id, invalid.key);
                    setQuestionErrors((old) => ({
                      ...old,
                      [question.id]: { message, fieldId },
                    }));
                    requestAnimationFrame(() => document.getElementById(fieldId)?.focus());
                    return;
                  }
                  const values: Record<string, string | string[] | boolean | number> = {};
                  for (const field of question.fields) {
                    const value = rawValues[field.key];
                    if (field.type === 'boolean') {
                      values[field.key] = value === true;
                    } else if (field.type === 'number' || field.type === 'integer') {
                      if (!isEmpty(value)) values[field.key] = Number(value);
                    } else if (value !== undefined) {
                      values[field.key] = value;
                    }
                  }
                  setQuestionErrors((old) => {
                    const next = { ...old };
                    delete next[question.id];
                    return next;
                  });
                  const projectId = a.projects.project()?.id;
                  if (projectId)
                    void a.act({
                      type: 'answer',
                      projectId,
                      requestId: question.id,
                      answer: values,
                    });
                }}
              >
                <h4>{question.title}</h4>
                <Show when={questionErrors()[question.id]?.message}>
                  <p class="inline-error" role="alert">
                    {questionErrors()[question.id]?.message}
                  </p>
                </Show>
                <For each={question.fields}>
                  {(field) => {
                    const fieldId = questionFieldId(question.id, field.key);
                    const descriptionId = `${fieldId}-description`;
                    const invalid = () => questionErrors()[question.id]?.fieldId === fieldId;
                    return (
                      <label class="field-label">
                        {field.title || field.key}
                        <Show when={field.description}>
                          <span id={descriptionId}>{field.description}</span>
                        </Show>
                        <Show
                          when={field.type !== 'external'}
                          fallback={
                            <p id={fieldId} tabIndex={-1}>
                              This question needs a control that Loom cannot display. Answer in the
                              harness or stop this request.
                            </p>
                          }
                        >
                          <Show
                            when={field.options.length}
                            fallback={
                              <input
                                id={fieldId}
                                type={field.type === 'boolean' ? 'checkbox' : 'text'}
                                inputmode={
                                  field.type === 'number' || field.type === 'integer'
                                    ? 'decimal'
                                    : undefined
                                }
                                value={
                                  field.type === 'boolean'
                                    ? undefined
                                    : String(answers()[question.id]?.[field.key] ?? '')
                                }
                                checked={
                                  field.type === 'boolean'
                                    ? answers()[question.id]?.[field.key] === true
                                    : undefined
                                }
                                required={field.required && field.type !== 'boolean'}
                                aria-invalid={
                                  field.type !== 'boolean' && invalid() ? 'true' : undefined
                                }
                                aria-describedby={field.description ? descriptionId : undefined}
                                onInput={(e) =>
                                  updateQuestionAnswer(
                                    question.id,
                                    fieldId,
                                    field.key,
                                    field.type === 'boolean'
                                      ? e.currentTarget.checked
                                      : e.currentTarget.value,
                                  )
                                }
                              />
                            }
                          >
                            <select
                              id={fieldId}
                              multiple={field.type === 'multiselect'}
                              value={answers()[question.id]?.[field.key] as string | undefined}
                              required={field.required && field.type !== 'boolean'}
                              aria-invalid={invalid() ? 'true' : undefined}
                              aria-describedby={field.description ? descriptionId : undefined}
                              aria-label={field.title || field.key}
                              onChange={(e) =>
                                updateQuestionAnswer(
                                  question.id,
                                  fieldId,
                                  field.key,
                                  field.type === 'multiselect'
                                    ? Array.from(e.currentTarget.selectedOptions).map(
                                        (o) => o.value,
                                      )
                                    : e.currentTarget.value,
                                )
                              }
                            >
                              <Show when={field.type !== 'multiselect'}>
                                <option value="">Choose an answer</option>
                              </Show>
                              <For each={field.options}>
                                {(option) => <option value={option.value}>{option.label}</option>}
                              </For>
                            </select>
                          </Show>
                        </Show>
                      </label>
                    );
                  }}
                </For>
                <div class="button-row">
                  <Show when={question.rejectable}>
                    <button
                      type="button"
                      class="secondary-button"
                      disabled={a.busy()}
                      onClick={() => {
                        const projectId = a.projects.project()?.id;
                        if (projectId)
                          void a.act({
                            type: 'answer',
                            projectId,
                            requestId: question.id,
                            answer: {},
                            reject: true,
                          });
                      }}
                    >
                      Deny
                    </button>
                  </Show>
                  <button
                    class="primary-button"
                    disabled={a.busy() || question.fields.some((f) => f.type === 'external')}
                  >
                    Send answer
                  </button>
                </div>
              </form>
            )}
          </For>
          <Show when={!follow()}>
            <button
              class="text-button agent-follow"
              onClick={() => {
                setFollow(true);
                scroller.scrollTop = scroller.scrollHeight;
              }}
            >
              Jump to latest
            </button>
          </Show>
        </div>
      </section>
    </Show>
  );
}

function AgentTurnAttachments(props: {
  agent: AgentWorkspace;
  turn: AgentTurn;
  compact?: boolean;
}) {
  return (
    <div class="agent-message-attachments" role="group" aria-label="Message attachments">
      <For each={attachedPaths(props.turn)}>
        {(path) => (
          <AgentAttachmentCard
            path={path}
            compact={props.compact}
            image={props.turn.images?.some((image) => image.path === path)}
            previewLabel={`View submitted image ${path}`}
            thumbnail={
              imageMime(path)
                ? () => props.agent.submittedImageThumbnail(props.turn.id, path)
                : undefined
            }
            onPreview={() => void props.agent.showSubmittedImage(props.turn.id, path)}
          />
        )}
      </For>
    </div>
  );
}
export function AgentImagePreview(props: { agent: AgentWorkspace }) {
  const a = props.agent;
  const [zoom, setZoom] = createSignal(1);
  const [expanded, setExpanded] = createSignal(false);
  createEffect(() => {
    a.imagePreview();
    setExpanded(false);
    setZoom(1);
  });
  return (
    <>
      <Show when={a.imagePreview()}>
        {(preview) => (
          <section class="agent-image-preview" aria-label="Project image preview">
            <div class="agent-image-preview-heading">
              <strong>{preview().submitted ? 'Submitted image' : 'Project image'}</strong>
              <span title={preview().path}>{preview().path}</span>
              <button class="text-button" onClick={() => setExpanded(true)}>
                Expand
              </button>
              <button class="text-button" onClick={a.closeImage}>
                Close image
              </button>
            </div>
            <small>
              {preview().submitted
                ? 'Saved with this request for comparison.'
                : 'Current project file; it may have changed since it was sent.'}{' '}
              A successful build does not verify the interpretation.
            </small>
            <div class="agent-image-preview-toolbar">
              <button
                class="text-button"
                disabled={zoom() <= 1}
                onClick={() => setZoom(Math.max(1, zoom() - 0.5))}
              >
                Zoom out
              </button>
              <span aria-live="polite">{Math.round(zoom() * 100)}%</span>
              <button
                class="text-button"
                disabled={zoom() >= 4}
                onClick={() => setZoom(Math.min(4, zoom() + 0.5))}
              >
                Zoom in
              </button>
            </div>
            <div
              class="agent-image-preview-canvas"
              tabindex="0"
              aria-label="Image; scroll to inspect"
            >
              <img
                src={preview().url}
                alt={`${preview().submitted ? 'Submitted image' : 'Current project image'}: ${preview().path}`}
                style={{ width: `${zoom() * 100}%` }}
              />
            </div>
          </section>
        )}
      </Show>
      <Modal
        title="Inspect image"
        open={expanded() && !!a.imagePreview()}
        onClose={() => setExpanded(false)}
      >
        <Show when={a.imagePreview()}>
          {(preview) => (
            <>
              <p class="muted">
                {preview().submitted
                  ? 'Submitted image saved with the request'
                  : 'Current project image'}
                : {preview().path}
              </p>
              <div class="agent-image-preview-toolbar">
                <button
                  class="text-button"
                  disabled={zoom() <= 1}
                  onClick={() => setZoom(Math.max(1, zoom() - 0.5))}
                >
                  Zoom out
                </button>
                <span aria-live="polite">{Math.round(zoom() * 100)}%</span>
                <button
                  class="text-button"
                  disabled={zoom() >= 4}
                  onClick={() => setZoom(Math.min(4, zoom() + 0.5))}
                >
                  Zoom in
                </button>
              </div>
              <div
                class="agent-image-expanded-canvas"
                tabindex="0"
                aria-label="Expanded image; scroll to inspect"
              >
                <img
                  src={preview().url}
                  alt={`${preview().submitted ? 'Submitted image' : 'Current project image'}: ${preview().path}`}
                  style={{ width: `${zoom() * 100}%` }}
                />
              </div>
            </>
          )}
        </Show>
      </Modal>
    </>
  );
}
export function AgentComposer(props: {
  agent: AgentWorkspace;
  onConnect: () => void;
  onNewChat: () => void;
}) {
  const a = props.agent;
  let input!: HTMLTextAreaElement;
  const ready = () => a.state()?.connection === 'connected',
    running = () => a.state()?.running || a.submitting(),
    requestUncertain = () => a.state()?.error.startsWith('Request status uncertain: ') ?? false,
    statusUnavailable = () =>
      a.state()?.error.startsWith('Could not refresh agent status: ') ?? false;
  return (
    <>
      <div class="composer agent-composer">
        <Show when={a.state()?.connection === 'interrupted'}>
          <div class="agent-connection-warning" role="alert">
            <span>Agent connection interrupted. Partial work is retained.</span>
            <Show
              when={a.state()?.ownership === 'external'}
              fallback={
                <button
                  class="text-button"
                  disabled={a.busy()}
                  onClick={() => {
                    const harness = a.state()?.harness;
                    if (harness) void a.connect(harness);
                  }}
                >
                  Reconnect {a.state()?.harness === 'codex' ? 'Codex' : 'OpenCode'}
                </button>
              }
            >
              <button class="text-button" onClick={props.onConnect}>
                Connection details
              </button>
            </Show>
          </div>
        </Show>
        <Show when={a.attachments().length || a.selection()}>
          <div class="agent-draft-attachments" role="group" aria-label="Attachments to send">
            <For each={a.attachments()}>
              {(path) => (
                <AgentAttachmentCard
                  path={path}
                  image={!!imageMime(path)}
                  compact
                  thumbnail={imageMime(path) ? () => a.projectImageThumbnail(path) : undefined}
                  revision={
                    a.projects.project()?.files.find((file) => file.path === path)?.diskRevision
                  }
                  onPreview={() => void a.showImage(path)}
                  disabled={a.busy() || running()}
                  onRemove={() => {
                    a.setAttachments((old) => old.filter((p) => p !== path));
                    input?.focus();
                  }}
                />
              )}
            </For>
            <Show when={a.selection()}>
              {(selected) => (
                <AgentAttachmentCard
                  path={selected().path}
                  compact
                  detail="Selected passage"
                  removeLabel={`Remove selected passage ${selected().path}`}
                  disabled={a.busy() || running()}
                  onRemove={() => {
                    a.setSelection(null);
                    input?.focus();
                  }}
                />
              )}
            </Show>
          </div>
        </Show>
        <textarea
          ref={input}
          class="agent-prompt resize-none"
          aria-label="Ask about your paper"
          title="Paste an image to add it to this paper and attach it"
          placeholder={
            a.projects.project() ? 'Ask anything' : 'Open a paper to work with an agent…'
          }
          rows={2}
          style={{ resize: 'none' }}
          maxLength={50000}
          value={a.draft()}
          onInput={(e) => a.setDraft(e.currentTarget.value)}
          onPaste={(e) => {
            if (!e.clipboardData) return;
            const image = [...e.clipboardData.files].find((file) => file.type.startsWith('image/'));
            if (image) {
              if (!e.clipboardData.getData('text/plain')) e.preventDefault();
              void a.pasteImage(image);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
              e.preventDefault();
              void a.send();
            }
          }}
        />
        <Show
          when={
            a.projects.file() &&
            !a.selection() &&
            (() => {
              const caret = a.projects.caret(a.projects.file()!.id);
              return caret && caret.anchor !== caret.head;
            })()
          }
        >
          <button
            class="text-button agent-selection-action"
            onClick={() => a.attachSelection()}
            disabled={running()}
          >
            Attach selected text
          </button>
        </Show>
        <div class="composer-actions">
          <IconButton
            label="Attach paper files or images"
            icon="plus"
            disabled={!a.projects.project() || running() || a.busy()}
            onClick={() => void a.attachFiles().finally(() => input?.focus())}
          />
          <AgentChatMenus agent={a} onConnect={props.onConnect} />
          <IconButton label="Agent connections" icon="plug" onClick={props.onConnect} />
          <button
            class="send-button"
            disabled={
              a.state()?.connection === 'interrupted' ||
              (running()
                ? a.busy() && !a.submitting()
                : !ready() ||
                  a.state()?.sessionUnavailable ||
                  !a.model() ||
                  (a.attachments().some((path) => imageMime(path)) && !a.model()?.images) ||
                  !a.draft().trim() ||
                  a.busy())
            }
            aria-label={
              a.state()?.connection === 'interrupted'
                ? 'Agent interrupted'
                : running()
                  ? 'Stop agent request'
                  : 'Send to agent'
            }
            title={
              a.state()?.connection === 'interrupted'
                ? 'Reconnect the agent before continuing'
                : running()
                  ? 'Stop agent request'
                  : 'Send · Ctrl Enter'
            }
            onClick={() => {
              if (a.state()?.connection === 'interrupted') return;
              if (running()) void a.cancel();
              else void a.send();
            }}
          >
            <Show
              when={a.state()?.connection !== 'interrupted' && running()}
              fallback={
                <Icon name={a.state()?.connection === 'interrupted' ? 'plug' : 'arrow'} size={22} />
              }
            >
              <span class="agent-stop-square" />
            </Show>
          </button>
        </div>
      </div>
      <Show
        when={a.attachments().some((path) => imageMime(path)) && a.model() && !a.model()?.images}
      >
        <div class="agent-inline-error" role="status">
          This model does not report image support. Choose an image-capable model from the model
          menu before sending.
        </div>
      </Show>
      <Show when={ready() && !a.state()?.models.length}>
        <div class="agent-inline-error">
          <span>No models available. Configure a model in your agent, then reconnect.</span>
          <button class="text-button" onClick={props.onConnect}>
            Agent setup
          </button>
        </div>
      </Show>

      <div class="agent-composer-status">
        <button class="text-button" onClick={() => a.setOpen(!a.open())}>
          {a.open()
            ? 'Hide conversation'
            : a.state()?.permissions.length
              ? 'View permission request'
              : a.state()?.questions.length
                ? 'Answer agent question'
                : 'Show conversation'}
        </button>
        <span role="status" aria-live="polite">
          {a.initializing()
            ? 'Checking agent connection…'
            : a.state()?.connection === 'interrupted'
              ? 'Agent interrupted'
              : a.state()?.sessionUnavailable
                ? 'Conversation needs recovery'
                : requestUncertain()
                  ? 'Request status uncertain'
                  : statusUnavailable()
                    ? 'Agent status unavailable'
                    : a.state()?.permissions.length
                      ? 'Needs your permission'
                      : a.state()?.questions.length
                        ? 'Needs your answer'
                        : running()
                          ? 'Agent working'
                          : ready()
                            ? 'Agent connected'
                            : 'Agent disconnected'}
        </span>
      </div>
      <Show when={(a.error() || a.state()?.error) && a.state()?.connection !== 'interrupted'}>
        <div
          class="agent-inline-error"
          classList={{ 'agent-recovery': !!a.state()?.restore && !a.error() }}
          role={a.state()?.restore && !a.error() ? 'status' : 'alert'}
        >
          <span>{a.error() || a.state()?.error}</span>
          <Show when={a.state()?.sessionUnavailable}>
            <Show
              when={a.state()?.restore?.reason === 'missing'}
              fallback={
                <button
                  class="text-button"
                  disabled={a.busy() || running()}
                  onClick={() => {
                    const state = a.state();
                    if (state?.sessionId)
                      void a.act({
                        type: 'retry-session',
                        projectId: state.projectId,
                        sessionId: state.sessionId,
                      });
                  }}
                >
                  Retry conversation
                </button>
              }
            >
              <button
                class="text-button"
                disabled={a.busy() || running()}
                onClick={() => {
                  const state = a.state();
                  if (state?.sessionId)
                    void a.act({
                      type: 'recover-session',
                      projectId: state.projectId,
                      sessionId: state.sessionId,
                    });
                }}
              >
                Continue conversation
              </button>
            </Show>
          </Show>
          <button class="text-button" onClick={props.onConnect}>
            Connection details
          </button>
        </div>
      </Show>
    </>
  );
}
