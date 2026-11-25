// The v2 data of one directory over a shared client and event stream. Kept free of JSX and webview contexts, so the
// extension tests can load it.
import type { ModelInfo, OpenCodeClient } from "@opencode/client"
import { createClientConnection, createData } from "@opencode/client/solid"
import type { KiloGatewayRpc } from "@opencode/schema/kilocode/gateway"
import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { createConnectionMetadata, type ConnectionMetadata } from "./connection-metadata"
import { toFailure, type Failure } from "./error"
import type { events } from "./events"
import { failureNeedsSignIn } from "./kilo-catalog"
import { createKiloModels } from "./kilo-models"
import { createModelDrafts } from "./model-draft"
import { createWakeups } from "./wakeups"

type Connection = ReturnType<typeof createClientConnection>
type Events = ReturnType<typeof events>

/** Retry delays for a failed session list; a longer window than the handshake covers a server that is restarted. */
const LIST_RETRY = [1_000, 3_000, 10_000] as const

/**
 * The data of one directory over a shared client and event stream: the sidebar has one, the Agent Manager one per
 * project and worktree. Call it inside a reactive owner; disposing the owner releases the store.
 */
export function createV2Scope(input: {
  api: OpenCodeClient
  connection: Connection
  event: Events
  directory: string
  /** Server-wide metadata shared by every store of one connection. Created here when omitted. */
  shared?: ConnectionMetadata
  /** Whether the session list of this directory is shown. A hidden directory loads it when it becomes visible. */
  visible?: Accessor<boolean>
  bindings: Accessor<Record<string, string>>
  /** Whether the active editor has selected text, which the prompt hint reads. */
  selection: Accessor<boolean>
  /**
   * Loads the sidebar data: the session list and the Kilo Gateway catalog status. The Settings and Profile panels
   * pass false, because neither renders a transcript and neither shows the catalog failure.
   */
  chat?: boolean
  onCommand: (handler: (name: string) => void) => void
  /** Opens an external URL through the host. */
  /** Opens a web link. `external` (shift-click) asks for the system browser instead of the Integrated Browser. */
  open: (url: string, external?: boolean) => void
  /**
   * Whether a Session holds a future wakeup. A panel with several directories supplies one store for all of them; a
   * single-directory scope reads its own directory instead.
   */
  scheduled?: (sessionID: string) => boolean
}) {
  const api = input.api
  const directory = input.directory
  const connection = input.connection
  const chat = input.chat ?? true
  // The host inlines the extension version; the server handshake reports the server version separately.
  const extensionVersion =
    typeof window === "undefined" ? "" : ((window as unknown as { KILO_EXTENSION_VERSION?: string }).KILO_EXTENSION_VERSION ?? "")
  const [failure, setFailure] = createSignal<Failure>()
  const [loading, setLoading] = createSignal(true)
  const data = createData({
    api: () => api,
    directory,
    connection,
    event: input.event,
    onError: (err) => setFailure(toFailure(err)),
  })
  const metadata =
    input.shared ??
    createConnectionMetadata({
      api,
      connection,
      chat,
      subscribe: (type, handler) => input.event.on(type, handler),
    })
  metadata.attach(directory)
  const kiloModels = createKiloModels({
    api,
    directory,
    models: () => data.location.model.list(),
    cache: metadata.kiloModelsCache,
  })
  // The composer's model drafts live with the directory, not the chat view, so an effort change survives the history
  // view and an Agent Manager worktree switch, as the TUI keeps them app-wide. The echo of a commit, or any client
  // switching the session to the same model, makes a draft redundant.
  const drafts = createModelDrafts()
  onCleanup(input.event.on("session.model.selected", (event) => drafts.settle(event.data.sessionID, event.data.model)))
  onCleanup(input.event.on("session.deleted", (event) => drafts.drop(event.data.sessionID)))
  // Revalidate persisted drafts on catalog reload and clear stale pre-recovery/Wave-1 failures once usable models
  // return after auth or catalog recovery, without hiding brand-new post-recovery errors.
  const recovery = createCatalogRecovery({
    models: () => data.location.model.list(),
    kiloFailure: metadata.kiloFailure,
    drafts,
    clearFailure: () => setFailure(undefined),
    clearAuthFailure: () => setFailure((current) => (current?.auth ? undefined : current)),
  })
  onCleanup(
    input.event.on("credential.switched", (event) =>
      recovery.onCredentialSwitched(event.data.integrationID, event.data.credentialID !== null),
    ),
  )
  onCleanup(input.event.on("provider.updated", recovery.onCatalogEvent))
  onCleanup(input.event.on("model.updated", recovery.onCatalogEvent))
  const visible = input.visible ?? (() => true)
  // Settings scopes draw no sessions, so only a chat scope that was not given a shared store reads its own directory.
  const wakeups =
    input.scheduled || !chat
      ? undefined
      : createWakeups({
          api,
          directories: () => [directory],
          connected: () => connection.status() === "connected",
        })
  const state = {
    listed: false,
    retry: undefined as ReturnType<typeof setTimeout> | undefined,
    reported: undefined as Failure | undefined,
  }
  onCleanup(() => clearTimeout(state.retry))
  // A failed read must not leave the list empty for the life of the connection: it releases the latch so the next
  // connected or visible transition retries, and a short backoff covers one bad response on a healthy connection.
  const list = (attempt = 0) => {
    clearTimeout(state.retry)
    state.listed = true
    setLoading(true)
    void api.session
      .list({ directory, parentID: null, order: "desc", limit: 50 })
      .then((response) => {
        response.data.forEach(data.session.remember)
        // Clear the failure this list reported, not one a later action owns.
        const reported = state.reported
        if (reported === undefined) return
        state.reported = undefined
        setFailure((current) => (current === reported ? undefined : current))
      })
      .catch((err: unknown) => {
        const failure = toFailure(err)
        state.listed = false
        state.reported = failure
        setFailure(failure)
        const delay = LIST_RETRY[attempt]
        if (delay === undefined) return
        state.retry = setTimeout(() => {
          if (state.listed || connection.status() !== "connected" || !visible()) return
          list(attempt + 1)
        }, delay)
      })
      .finally(() => setLoading(false))
  }
  createEffect(
    on(connection.status, (status) => {
      if (status !== "connected") state.listed = false
    }),
  )
  createEffect(
    on(
      () => [connection.status(), visible()] as const,
      ([status, show]) => {
        if (!chat) {
          setLoading(false)
          return
        }
        if (status !== "connected" || !show || state.listed) return
        list()
      },
    ),
  )

  return {
    api,
    data,
    directory,
    connection,
    loading,
    bindings: input.bindings,
    selection: input.selection,
    version: metadata.version,
    extensionVersion,
    handshake: metadata.handshake,
    /** The last failure this window reported; undefined once it is dismissed. */
    failure,
    /** Why the Kilo Gateway catalog failed to load; undefined while it is usable or loading. */
    kiloFailure: metadata.kiloFailure,
    /** The Kilo Gateway model metadata and the account team, for the model pickers. */
    kiloModels,
    /** The composer's uncommitted model and effort per session; the next prompt commits it. */
    drafts,
    /** Whether a Session holds a future wakeup, shown as `scheduled` instead of idle. */
    scheduled: input.scheduled ?? wakeups?.scheduled ?? (() => false),
    clearError: () => setFailure(undefined),
    report: (err: unknown) => setFailure(toFailure(err)),
    open: input.open,
    onCommand: input.onCommand,
  }
}

export type V2 = ReturnType<typeof createV2Scope>

/** True when the server reports that a session does not exist: the client names declared errors by their tag. */
export function sessionMissing(error: unknown) {
  return error instanceof Error && error.name === "SessionNotFoundError"
}

export { message } from "./error"

function createCatalogRecovery(input: {
  models: Accessor<readonly ModelInfo[] | undefined>
  kiloFailure: Accessor<KiloGatewayRpc.CatalogFailure | undefined>
  drafts: ReturnType<typeof createModelDrafts>
  clearFailure: () => void
  clearAuthFailure: () => void
}) {
  const state = {
    switched: false,
    switchedIntegration: undefined as string | undefined,
    catalogUpdated: false,
    emptyCatalog: false,
    previousEnabled: new Set<string>(),
    previousProviders: new Set<string>(),
  }

  createEffect(
    on(input.models, (list) => {
      if (!list) return
      const enabled = list.filter((item) => item.enabled)
      const keys = new Set(enabled.map((item) => `${item.providerID}/${item.id}`))
      const providers = new Set(enabled.map((item) => item.providerID))

      // Revalidate persisted drafts once a non-empty catalog settles; skip empty Wave-1 reloads.
      if (list.length > 0) input.drafts.prune((ref) => keys.has(`${ref.providerID}/${ref.id}`))

      if (enabled.length === 0) {
        state.emptyCatalog = true
        return
      }

      const added = enabled.some((item) => !state.previousEnabled.has(`${item.providerID}/${item.id}`))
      const awaitingSwitched =
        state.switched &&
        state.switchedIntegration !== undefined &&
        state.previousProviders.has(state.switchedIntegration) &&
        !providers.has(state.switchedIntegration)

      const switched = state.switched
      const catalogUpdated = state.catalogUpdated
      const wasEmpty = state.emptyCatalog

      state.previousEnabled = keys
      state.previousProviders = providers
      state.emptyCatalog = false
      state.catalogUpdated = false
      if (!awaitingSwitched) {
        state.switched = false
        state.switchedIntegration = undefined
      }

      if (switched || (catalogUpdated && wasEmpty)) {
        input.clearFailure()
        return
      }
      if (catalogUpdated && added) {
        const kilo = input.kiloFailure()
        if (!kilo || !failureNeedsSignIn(kilo)) input.clearAuthFailure()
      }
    }),
  )

  return {
    onCredentialSwitched(integrationID: string, active: boolean) {
      state.switched = true
      state.switchedIntegration = active ? integrationID : undefined
    },
    onCatalogEvent() {
      state.catalogUpdated = true
    },
  }
}
