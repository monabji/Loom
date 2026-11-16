import { createEffect, createMemo, createSignal, For, Show, createUniqueId } from 'solid-js';
import type { HarnessKind } from '../../contracts/agent';
import { Icon } from '../ui/Icon';
import { ProviderLogo, providerName as harnessName } from '../ui/ProviderLogo';
import { Modal } from '../ui/primitives';
import { type AgentWorkspace } from './workspace';
import './connections.css';

type ConnectionsTab = 'overview' | 'models' | 'runtime';
const harnesses: HarnessKind[] = ['opencode', 'codex'];

export function AgentConnections(props: {
  agent: AgentWorkspace;
  open: boolean;
  onClose: () => void;
  onConnected?: () => void;
  onOpenProject: () => void;
}) {
  const a = props.agent;
  const [selected, setSelected] = createSignal<HarnessKind>('opencode');
  const [tab, setTab] = createSignal<ConnectionsTab>('overview');
  const [external, setExternal] = createSignal(false);
  const [externalDetailsKnown, setExternalDetailsKnown] = createSignal(true);
  const [endpoint, setEndpoint] = createSignal('http://127.0.0.1:4096');
  const [username, setUsername] = createSignal('opencode');
  const [password, setPassword] = createSignal('');
  const [showPassword, setShowPassword] = createSignal(false);
  const [modelQuery, setModelQuery] = createSignal('');
  const [modelLimit, setModelLimit] = createSignal(100);
  const id = createUniqueId();
  let wasOpen = false;
  let modelSearch!: HTMLInputElement;

  createEffect(() => {
    if (props.open && !wasOpen) {
      setSelected(a.state()?.harness ?? 'opencode');
      setTab('overview');
      setModelQuery('');
      setModelLimit(100);
      if (
        a.state()?.harness === 'opencode' &&
        (a.state()?.connection === 'connected' || a.state()?.connection === 'interrupted') &&
        a.state()?.ownership === 'external' &&
        !external()
      ) {
        setExternal(true);
        setExternalDetailsKnown(false);
      }
      void a.refresh(true);
    }
    if (!props.open) {
      setPassword('');
      setShowPassword(false);
    }
    wasOpen = props.open;
  });

  const provider = () => a.state()?.providers.find((item) => item.id === selected());
  const connected = () =>
    a.state()?.harness === selected() && a.state()?.connection === 'connected';
  const interrupted = () =>
    a.state()?.harness === selected() && a.state()?.connection === 'interrupted';

  createEffect(() => {
    if (
      props.open &&
      selected() === 'opencode' &&
      connected() &&
      a.state()?.ownership === 'external' &&
      !external()
    ) {
      setExternal(true);
      setExternalDetailsKnown(false);
    }
  });

  const status = (harness: HarnessKind) => {
    if (!a.projects.project()) return 'Open a paper to check';
    const entry = a.state()?.providers.find((item) => item.id === harness);
    if (
      entry?.connected ||
      (a.state()?.harness === harness && a.state()?.connection === 'connected')
    )
      return 'Connected';
    if (a.state()?.harness === harness && a.state()?.connection === 'interrupted')
      return 'Interrupted';
    if (!entry || entry.version === 'Not checked') return 'Checking installation';
    if (!entry.installed) return 'Not installed';
    if (entry.auth === 'required') return 'Sign-in required';
    if (entry.auth === 'available') return 'Account ready';
    return 'Installed';
  };
  const statusTone = (harness: HarnessKind) => {
    const current = status(harness);
    if (current === 'Connected') return 'connected';
    if (current === 'Interrupted') return 'interrupted';
    if (current === 'Not installed' || current === 'Sign-in required') return 'attention';
    return 'quiet';
  };
  const version = () => {
    const value = provider()?.version;
    if (!value || value === 'Not checked') return 'Version checking';
    if (value === 'Not installed') return value;
    return /^\d/.test(value) ? `v${value}` : value;
  };
  const availableModels = createMemo(() => {
    const query = modelQuery().trim().toLocaleLowerCase();
    const models = connected() ? (a.state()?.models ?? []) : [];
    if (!query) return models;
    return models.filter((model) =>
      `${model.name} ${model.providerId} ${model.id}`.toLocaleLowerCase().includes(query),
    );
  });
  const visibleModels = createMemo(() => availableModels().slice(0, modelLimit()));
  const isSetupRequired = () => {
    const entry = provider();
    return (
      !!entry &&
      entry.version !== 'Not checked' &&
      !entry.installed &&
      tab() !== 'runtime' &&
      !a.runtimePath(selected()).trim() &&
      !(selected() === 'opencode' && external())
    );
  };
  const connectLabel = () => {
    if (a.busy()) return 'Connecting…';
    if (interrupted()) return `Reconnect ${harnessName(selected())}`;
    if (provider()?.connected) return `Use ${harnessName(selected())}`;
    if (isSetupRequired()) return `Set up ${harnessName(selected())}`;
    return `Connect ${harnessName(selected())}`;
  };

  const selectTab = (next: ConnectionsTab) => setTab(next);
  const tabKeyDown = (event: KeyboardEvent) => {
    const order: ConnectionsTab[] = ['overview', 'models', 'runtime'];
    const current = order.indexOf(tab());
    let next = current;
    if (event.key === 'ArrowRight') next = (current + 1) % order.length;
    else if (event.key === 'ArrowLeft') next = (current + order.length - 1) % order.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = order.length - 1;
    else return;
    event.preventDefault();
    setTab(order[next]);
    requestAnimationFrame(() => document.getElementById(`${id}-tab-${order[next]}`)?.focus());
  };

  const onConnect = () => {
    if (isSetupRequired()) {
      void window.loom?.openSetup(selected());
      return;
    }
    void a
      .connect(
        selected(),
        selected() === 'opencode' && external() ? endpoint() : undefined,
        selected() === 'opencode' && external() ? username() : undefined,
        selected() === 'opencode' && external() ? password() : undefined,
        a.runtimePath(selected()) || undefined,
      )
      .then((ok) => {
        if (ok) {
          setPassword('');
          setTab('overview');
          if (selected() === 'opencode' && external()) setExternalDetailsKnown(true);
          props.onConnected?.();
        }
      });
  };

  return (
    <Modal
      open={props.open}
      title="Agent connections"
      icon="plug"
      onClose={props.onClose}
      initialFocus='.agent-provider-option[aria-pressed="true"]'
    >
      <div class="agent-connections">
        <aside class="agent-provider-rail" aria-label="Supported agents">
          <div class="agent-provider-rail-heading">
            <strong>Providers</strong>
            <span>Choose your agent</span>
          </div>
          <div class="agent-provider-list" role="group" aria-label="Agent providers">
            <For each={harnesses}>
              {(harness) => (
                <button
                  class="agent-provider-option"
                  classList={{ selected: selected() === harness }}
                  aria-pressed={selected() === harness}
                  onClick={() => {
                    setSelected(harness);
                    setModelQuery('');
                    setModelLimit(100);
                  }}
                >
                  <span class={`agent-provider-mark ${harness}`} aria-hidden="true">
                    <ProviderLogo provider={harness} size={22} />
                  </span>
                  <span class="agent-provider-option-copy">
                    <span class="agent-provider-name-line">
                      <strong>{harnessName(harness)}</strong>
                      <small>
                        {(() => {
                          const value = a
                            .state()
                            ?.providers.find((item) => item.id === harness)?.version;
                          return value && value !== 'Not checked' && value !== 'Not installed'
                            ? value.startsWith('v')
                              ? value
                              : `v${value}`
                            : '';
                        })()}
                      </small>
                    </span>
                    <span
                      class={`agent-provider-status ${statusTone(harness)}`}
                      aria-label={`${harnessName(harness)}: ${status(harness)}`}
                    >
                      <span aria-hidden="true" />
                      {status(harness)}
                    </span>
                  </span>
                </button>
              )}
            </For>
          </div>
          <p class="agent-provider-rail-note">
            Loom uses each agent’s existing account and models.
          </p>
        </aside>

        <section class="agent-connection-detail" aria-label={`${harnessName(selected())} settings`}>
          <header class="agent-connection-heading">
            <span class={`agent-provider-mark large ${selected()}`} aria-hidden="true">
              <ProviderLogo provider={selected()} size={26} />
            </span>
            <div class="agent-connection-heading-copy">
              <h3>{harnessName(selected())}</h3>
              <p>{version()}</p>
            </div>
            <span class={`agent-provider-status connection ${statusTone(selected())}`}>
              <span aria-hidden="true" />
              {status(selected())}
            </span>
          </header>

          <Show
            when={a.projects.project()}
            fallback={
              <div class="agent-project-required">
                <div class="agent-project-required-mark" aria-hidden="true">
                  <Icon name="folder" size={22} />
                </div>
                <h4>Connect an agent to a paper</h4>
                <p>Open or create a paper folder to check installations and manage its agent.</p>
                <button class="primary-button" onClick={props.onOpenProject}>
                  Open or create project
                </button>
              </div>
            }
          >
            <nav class="agent-connection-tabs" role="tablist" aria-label="Agent settings">
              <For each={['overview', 'models', 'runtime'] as ConnectionsTab[]}>
                {(item) => (
                  <button
                    id={`${id}-tab-${item}`}
                    type="button"
                    role="tab"
                    aria-selected={tab() === item}
                    aria-controls={`${id}-panel-${item}`}
                    tabIndex={tab() === item ? 0 : -1}
                    onClick={() => selectTab(item)}
                    onKeyDown={tabKeyDown}
                  >
                    <Icon
                      name={item === 'overview' ? 'info' : item === 'models' ? 'cpu' : 'terminal'}
                      size={15}
                    />
                    {item === 'runtime' ? 'Runtime' : item[0].toUpperCase() + item.slice(1)}
                  </button>
                )}
              </For>
            </nav>

            <div class="agent-connection-content">
              <section
                class="agent-connection-panel overview"
                id={`${id}-panel-overview`}
                role="tabpanel"
                aria-labelledby={`${id}-tab-overview`}
                tabIndex={0}
                hidden={tab() !== 'overview'}
              >
                <div class="agent-account-summary">
                  <div class="agent-summary-copy">
                    <span class="agent-summary-eyebrow">Account and access</span>
                    <h4>
                      {connected()
                        ? provider()?.auth === 'required'
                          ? 'Sign-in required'
                          : provider()?.auth === 'available'
                            ? 'Account configured'
                            : 'Connected to this paper'
                        : interrupted()
                          ? 'Connection interrupted'
                          : !provider() || provider()?.version === 'Not checked'
                            ? 'Checking installation'
                            : provider()?.installed
                              ? 'Installed on this device'
                              : 'Set up this agent'}
                    </h4>
                    <p>
                      {connected()
                        ? provider()?.auth === 'required'
                          ? `Sign in to ${harnessName(selected())}, then reconnect. Model access is checked when you send.`
                          : !a.state()?.models.length
                            ? `No models were reported. Configure one in ${harnessName(selected())}, then reconnect.`
                            : provider()?.auth === 'available'
                              ? 'Your agent reports a configured account. Model access is checked when you send.'
                              : `${a.state()?.models.length ?? 0} models were reported by the harness. Access is checked when you send.`
                        : !provider() || provider()?.version === 'Not checked'
                          ? `Checking ${harnessName(selected())} on this device.`
                          : provider()?.installed
                            ? `Loom reuses the account and configured models from ${harnessName(selected())}. Sign in there when needed.`
                            : `Install ${harnessName(selected())} and sign in with its own account to make models available.`}
                    </p>
                  </div>
                  <span class={`agent-account-status ${statusTone(selected())}`}>
                    <span aria-hidden="true" />
                    {status(selected())}
                  </span>
                </div>

                <Show when={!connected()}>
                  <p class="agent-setup-hint">
                    {provider()?.installed ? 'Need to sign in? Use' : `After installing, use`}{' '}
                    <code>{selected() === 'codex' ? 'codex login' : 'opencode auth login'}</code> in
                    the agent's own terminal. Loom does not store provider credentials.
                  </p>
                </Show>

                <details class="agent-data-disclosure">
                  <summary>Data and file access</summary>
                  <p>
                    Your request, selected attachments, and files the harness reads are sent to its
                    configured model. The harness acts with its own permissions, which may include
                    files outside this paper. It can edit project files directly; Loom shows those
                    changes for review afterward. Loom does not store or copy provider credentials.
                  </p>
                </details>
              </section>

              <section
                class="agent-connection-panel models"
                id={`${id}-panel-models`}
                role="tabpanel"
                aria-labelledby={`${id}-tab-models`}
                tabIndex={0}
                hidden={tab() !== 'models'}
              >
                <div class="agent-catalog-heading">
                  <div>
                    <h4>Model catalog</h4>
                    <p>Models reported by the connected {harnessName(selected())} instance.</p>
                  </div>
                  <Show when={connected()}>
                    <span class="agent-model-count">
                      {visibleModels().length < availableModels().length
                        ? `${visibleModels().length} of ${availableModels().length} shown`
                        : `${availableModels().length} models`}
                    </span>
                  </Show>
                </div>
                <Show
                  when={connected()}
                  fallback={
                    <div class="agent-catalog-empty">
                      <span class="agent-catalog-empty-icon" aria-hidden="true">
                        <Icon name="search" size={19} />
                      </span>
                      <h4>Connect {harnessName(selected())} to view models</h4>
                      <p>The catalog comes from the harness after it connects to this paper.</p>
                      <button class="text-button" onClick={() => setTab('overview')}>
                        Go to overview
                      </button>
                    </div>
                  }
                >
                  <label class="agent-model-search">
                    <Icon name="search" size={16} />
                    <input
                      ref={modelSearch}
                      type="text"
                      role="searchbox"
                      aria-label={`Search ${harnessName(selected())} models`}
                      placeholder="Search models"
                      value={modelQuery()}
                      onInput={(event) => {
                        setModelQuery(event.currentTarget.value);
                        setModelLimit(100);
                      }}
                      autocomplete="off"
                      spellcheck={false}
                    />
                    <Show when={modelQuery()}>
                      <button
                        class="agent-model-search-clear"
                        type="button"
                        aria-label="Clear model search"
                        title="Clear search"
                        onClick={() => {
                          setModelQuery('');
                          setModelLimit(100);
                          requestAnimationFrame(() => modelSearch?.focus());
                        }}
                      >
                        <Icon name="close" size={14} />
                      </button>
                    </Show>
                  </label>
                  <div class="agent-model-list" role="list" aria-label="Available models">
                    <Show
                      when={availableModels().length}
                      fallback={
                        <div class="agent-catalog-no-results" role="status">
                          <p>
                            {a.state()?.models.length
                              ? `No models match “${modelQuery()}”.`
                              : `No model catalog was reported by ${harnessName(selected())}.`}
                          </p>
                          <Show when={modelQuery()}>
                            <button class="text-button" onClick={() => setModelQuery('')}>
                              Clear search
                            </button>
                          </Show>
                          <Show when={!a.state()?.models.length}>
                            <small>
                              Configure a model in {harnessName(selected())}, then reconnect.
                            </small>
                          </Show>
                        </div>
                      }
                    >
                      <For each={visibleModels()}>
                        {(model) => (
                          <div class="agent-model-row" role="listitem">
                            <span class="agent-model-glyph" aria-hidden="true">
                              <Icon name="cpu" size={16} />
                            </span>
                            <span class="agent-model-copy">
                              <strong title={model.name}>{model.name}</strong>
                              <code title={`${model.providerId}:${model.id}`}>
                                {model.providerId}:{model.id}
                              </code>
                            </span>
                            <span class="agent-model-capabilities">
                              {model.images ? <span>Images</span> : null}
                              {model.tools ? <span>Tools</span> : null}
                              {!model.images && !model.tools ? <span>Text</span> : null}
                            </span>
                          </div>
                        )}
                      </For>
                    </Show>
                  </div>
                  <Show when={availableModels().length > visibleModels().length}>
                    <button
                      class="agent-model-load-more"
                      onClick={() => setModelLimit((limit) => limit + 100)}
                    >
                      Load 100 more models
                    </button>
                  </Show>
                </Show>
              </section>

              <section
                class="agent-connection-panel runtime"
                id={`${id}-panel-runtime`}
                role="tabpanel"
                aria-labelledby={`${id}-tab-runtime`}
                tabIndex={0}
                hidden={tab() !== 'runtime'}
              >
                <div class="agent-runtime-intro">
                  <span class="agent-summary-eyebrow">Local execution</span>
                  <h4>Runtime</h4>
                  <p>
                    Choose the OpenCode or Codex executable Loom launches on this device. Loom
                    checks compatibility when connecting, including older and newer releases.
                  </p>
                </div>
                <label class="agent-runtime-field">
                  <span>Binary path</span>
                  <small>
                    Leave blank to find {selected() === 'codex' ? 'codex' : 'opencode'} on PATH.
                  </small>
                  <input
                    type="text"
                    aria-label="Binary path"
                    value={a.runtimePath(selected())}
                    placeholder={selected() === 'codex' ? 'codex' : 'opencode'}
                    spellcheck={false}
                    autocomplete="off"
                    disabled={connected()}
                    onInput={(event) => a.setRuntimePath(selected(), event.currentTarget.value)}
                  />
                </label>

                <Show when={selected() === 'opencode'}>
                  <div class="agent-runtime-divider" />
                  <div class="agent-runtime-intro">
                    <span class="agent-summary-eyebrow">Existing server</span>
                    <h4>Connect to a local OpenCode server</h4>
                    <p>Loom attaches to the server and will not stop it when you disconnect.</p>
                  </div>
                  <label class="agent-runtime-check">
                    <input
                      type="checkbox"
                      checked={external()}
                      disabled={connected()}
                      onChange={(event) => {
                        setExternal(event.currentTarget.checked);
                        setExternalDetailsKnown(true);
                      }}
                    />
                    <span>Use an existing server</span>
                  </label>
                  <Show when={external()}>
                    <Show when={interrupted()}>
                      <p class="agent-runtime-unknown-server">
                        This existing server was interrupted. Loom does not retain its address or
                        password; enter them again to reconnect.
                      </p>
                    </Show>
                    <Show
                      when={!connected() || externalDetailsKnown()}
                      fallback={
                        <p class="agent-runtime-unknown-server">
                          This connection is attached to an existing server. Loom does not retain
                          its address or password, so those details are not shown here. Disconnect
                          to enter a server address for the next connection.
                        </p>
                      }
                    >
                      <div class="agent-runtime-fields">
                        <label class="agent-runtime-field">
                          <span>Server address</span>
                          <input
                            type="url"
                            inputmode="url"
                            value={endpoint()}
                            placeholder="http://127.0.0.1:4096"
                            autocomplete="url"
                            disabled={connected()}
                            onInput={(event) => setEndpoint(event.currentTarget.value)}
                          />
                        </label>
                        <label class="agent-runtime-field">
                          <span>Server username</span>
                          <input
                            type="text"
                            value={username()}
                            autocomplete="username"
                            disabled={connected()}
                            onInput={(event) => setUsername(event.currentTarget.value)}
                          />
                        </label>
                        <label class="agent-runtime-field">
                          <span>Server password</span>
                          <span class="agent-password-control">
                            <input
                              aria-label="Server password"
                              type={showPassword() ? 'text' : 'password'}
                              value={password()}
                              autocomplete="current-password"
                              disabled={connected()}
                              onInput={(event) => setPassword(event.currentTarget.value)}
                            />
                            <button
                              class="text-button"
                              type="button"
                              aria-pressed={showPassword()}
                              aria-label={
                                showPassword() ? 'Hide server password' : 'Show server password'
                              }
                              onClick={() => setShowPassword(!showPassword())}
                            >
                              {showPassword() ? 'Hide' : 'Show'}
                            </button>
                          </span>
                          <small>This password stays in memory for the connection.</small>
                        </label>
                      </div>
                    </Show>
                  </Show>
                </Show>
              </section>
            </div>
            <p class="agent-reconnect-note">
              {connected() && a.state()?.ownership === 'external'
                ? 'Existing servers require their connection details again after reopening Loom.'
                : 'Loom reconnects this paper’s last connected local agent when you reopen it. Disconnect to keep it offline.'}
            </p>
            <div class="agent-connection-actions">
              <Show
                when={connected()}
                fallback={
                  <button
                    class="primary-button"
                    disabled={
                      a.busy() || (!!a.state()?.running && a.state()?.connection === 'connected')
                    }
                    onClick={onConnect}
                  >
                    <Icon name={isSetupRequired() ? 'bookOpen' : 'plug'} size={16} />
                    {connectLabel()}
                  </button>
                }
              >
                <button
                  class="secondary-button"
                  disabled={a.busy()}
                  onClick={() => {
                    const projectId = a.projects.project()?.id;
                    if (projectId)
                      void a.act({ type: 'disconnect', projectId }).then((ok) => {
                        if (ok && !externalDetailsKnown()) {
                          setExternalDetailsKnown(true);
                          setEndpoint('http://127.0.0.1:4096');
                          setUsername('opencode');
                        }
                      });
                  }}
                >
                  <Icon name="disconnect" size={16} />
                  Disconnect
                </button>
              </Show>
              <button
                class="secondary-button"
                disabled={!a.projects.project()}
                onClick={() => void window.loom?.openSetup(selected())}
              >
                <Icon name="bookOpen" size={16} />
                Setup guide
              </button>
            </div>
          </Show>

          <Show when={a.error() || a.state()?.error}>
            <p class="agent-connections-error" role="alert">
              {a.error() || a.state()?.error}
            </p>
          </Show>
        </section>
      </div>
    </Modal>
  );
}
