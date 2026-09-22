/**
 * Staged form model behind the database settings page.
 *
 * The durable truth is the settings section: the saved connections and the one
 * the tools address. A dialog edit is a draft that becomes a whole-list write
 * when the user saves. The password is the one draft that never reaches the
 * section: it is written through the credential domain, keyed by the reference
 * the profile names, and never read back.
 *
 * @module dsh-ds-db/src/client/form
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { type DatabaseSettings, type DialectCatalog, type DialectDescriptor, type MysqlSettings } from '../contract.ts'

/** One editable field of the connection dialog, in form order. */
export type DbFormField
  = 'name' | 'host' | 'port' | 'user' | 'database'
  | 'passwordEnv' | 'connectTimeoutMs' | 'queryTimeoutMs' | 'maxRows'

/** Every field the dialog renders, in form order. */
export const DB_FORM_FIELDS: readonly DbFormField[] = [
  'name', 'host', 'port', 'user', 'database', 'passwordEnv',
  'connectTimeoutMs', 'queryTimeoutMs', 'maxRows',
]

/** The connection probe's state, owned by a card's or the dialog's Test button. */
export type DbProbe =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ok'; version: string; latencyMs: number }
  | { status: 'failed'; message: string }

/** One saved connection as a card renders it. */
export interface ConnectionCard {
  profile: MysqlSettings
  /** Whether the tools currently address this connection. */
  active: boolean
  /** Whether the Host reports a stored value for this profile's reference. */
  passwordConfigured: boolean
  /** The last probe of the saved connection. */
  probe: DbProbe
}

/** The connection dialog: the type chooser, or one profile's form. */
export type DbDialog =
  | { kind: 'closed' }
  | { kind: 'type' }
  | {
    kind: 'form'
    /** Whether saving adds a connection or replaces one. */
    mode: 'new' | 'edit'
    /** The id the profile is saved under; a fresh one for `new`. */
    id: string
    /** The dialect chosen in the type step. */
    dialect: string
    /** The connection fields this dialect declared, in its own order. */
    configFields: readonly DialectFieldDraft[]
    /** Draft text per shared form field. */
    fields: Record<DbFormField, string>
    /** Draft values per dialect field, keyed by the dialect's own keys. */
    extra: Record<string, string | number>
    /** The write-only password draft. */
    password: string
    /** The last probe of this draft. */
    probe: DbProbe
  }

/** One dialect field as the page renders it. */
export type DialectFieldDraft = DialectDescriptor['configFields'][number]

/** Everything the page renders. */
export interface DatabasePageState {
  /** False until the Host serves this settings namespace. */
  available: boolean
  /** Whether the Host settings document accepts writes. */
  writable: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save did not land as staged; cleared by the next save. */
  failed: boolean
  /** The saved connections as cards, in document order. */
  cards: ConnectionCard[]
  /** The database types the page may offer; undefined until the Host answers. */
  catalog: DialectCatalog | undefined
  /** The dialog, when one is open. */
  dialog: DbDialog
}

/** The credential-domain face the page writes and describes through. */
export interface MysqlCredentialsFace {
  describe: (ref: string) => Promise<{ configured: boolean; writable: boolean }>
  set: (ref: string, value: string) => Promise<void>
}

/** Write actions the page's slot entry injects. */
export interface DbFormActions {
  openNew: () => void
  /** Open the dialog on a pre-filled draft, for editing a saved connection. */
  openEdit: (draft: DbDialog) => void
  closeDialog: () => void
  chooseDialect: (dialect: string) => void
  editField: (field: DbFormField, text: string) => void
  /** Stage one dialect field's value. */
  editExtra: (key: string, text: string) => void
  editPassword: (text: string) => void
  testDraft: () => void
  saveDialog: () => void
  activate: (id: string) => void
  testSaved: (id: string) => void
  remove: (id: string) => void
}

/** Everything the page's slot entry injects. */
export interface DbPageFace extends DbFormActions {
  hooks: {
    /** Page snapshot, bound by the renderer as `useDbPage`. */
    dbPage: SnapshotStore<DatabasePageState>
  }
}

/** One offering of the type chooser. */
export interface DialectOffering {
  /** Registry key the connection is saved under. */
  dialect: string
  /** Whether the plugin can actually open a session for it. */
  available: boolean
}

/** The type chooser's offerings; only the bundled dialect is selectable today. */
export const DIALECT_OFFERINGS: readonly DialectOffering[] = [
  { dialect: 'mysql', available: true },
  { dialect: 'postgres', available: false },
  { dialect: 'oracle', available: false },
]

/** Whether a draft text is a positive whole number. */
function positiveInteger(text: string): number | undefined {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  return value >= 1 ? value : undefined
}

/** The validity rule per dialog field. */
const RULES: Record<DbFormField, (text: string) => boolean> = {
  name: text => text.trim().length > 0,
  host: text => text.trim().length > 0,
  port: (text) => {
    const value = positiveInteger(text)
    return value !== undefined && value <= 65535
  },
  user: text => text.trim().length > 0,
  // An empty database is meaningful: it means every tool call names its own.
  database: () => true,
  passwordEnv: text => /^[A-Za-z_][A-Za-z0-9_]*$/.test(text.trim()),
  connectTimeoutMs: text => positiveInteger(text) !== undefined,
  queryTimeoutMs: text => positiveInteger(text) !== undefined,
  maxRows: text => positiveInteger(text) !== undefined,
}

/** The invalid-key copy each field refuses with. */
export const FIELD_INVALID_KEY: Record<DbFormField, 'invalidText' | 'invalidNumber' | 'invalidReference'> = {
  name: 'invalidText',
  host: 'invalidText',
  port: 'invalidNumber',
  user: 'invalidText',
  database: 'invalidText',
  passwordEnv: 'invalidReference',
  connectTimeoutMs: 'invalidNumber',
  queryTimeoutMs: 'invalidNumber',
  maxRows: 'invalidNumber',
}

/** Whether every dialog field holds a value its rule accepts. */
export function dialogValid(dialog: DbDialog): boolean {
  if (dialog.kind !== 'form') return false
  return DB_FORM_FIELDS.every(field => RULES[field](dialog.fields[field]))
}

/** Whether one field's draft text is not a value its rule accepts. */
export function fieldInvalid(field: DbFormField, text: string): boolean {
  return !RULES[field](text)
}

/** The saved profile the dialog's draft parses to, or undefined while invalid. */
export function dialogProfile(dialog: DbDialog): MysqlSettings | undefined {
  if (dialog.kind !== 'form' || !dialogValid(dialog)) return undefined
  return {
    id: dialog.id,
    name: dialog.fields.name.trim(),
    dialect: dialog.dialect,
    extra: { ...dialog.extra },
    host: dialog.fields.host.trim(),
    port: Number(dialog.fields.port.trim()),
    user: dialog.fields.user.trim(),
    database: dialog.fields.database.trim(),
    passwordEnv: dialog.fields.passwordEnv.trim(),
    connectTimeoutMs: Number(dialog.fields.connectTimeoutMs.trim()),
    queryTimeoutMs: Number(dialog.fields.queryTimeoutMs.trim()),
    maxRows: Number(dialog.fields.maxRows.trim()),
  }
}

/** Draft text for one field, rendered from a saved profile. */
function fieldText(profile: MysqlSettings, field: DbFormField): string {
  switch (field) {
    case 'name': return profile.name
    case 'host': return profile.host
    case 'port': return String(profile.port)
    case 'user': return profile.user
    case 'database': return profile.database
    case 'passwordEnv': return profile.passwordEnv
    case 'connectTimeoutMs': return String(profile.connectTimeoutMs)
    case 'queryTimeoutMs': return String(profile.queryTimeoutMs)
    case 'maxRows': return String(profile.maxRows)
  }
}

/** A fresh dialog id for a connection the page is about to save. */
function freshId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `conn-${String(Date.now())}`
}

/** The empty draft text per field, for a new MySQL connection. */
function blankFields(): Record<DbFormField, string> {
  return {
    name: 'MySQL',
    host: '127.0.0.1',
    port: '3306',
    user: 'root',
    database: '',
    passwordEnv: 'DSH_MYSQL_PASSWORD',
    connectTimeoutMs: '10000',
    queryTimeoutMs: '30000',
    maxRows: '200',
  }
}

/**
 * A draft dialog pre-filled from one saved profile, for the edit path.
 * @param profile - the saved connection to edit.
 * @param catalog - the loaded catalog, which names the dialect's own fields;
 * without it the dialect's fields are carried over but not described.
 * @returns the dialog editing that profile.
 */
export function editDraftFor(profile: MysqlSettings, catalog?: DialectCatalog): DbDialog {
  const fields = {} as Record<DbFormField, string>
  for (const field of DB_FORM_FIELDS) fields[field] = fieldText(profile, field)
  const configFields = catalog?.installed.find(entry => entry.name === profile.dialect)?.configFields ?? []
  const extra: Record<string, string | number> = {}
  for (const field of configFields) extra[field.key] = profile.extra[field.key] ?? field.default
  // A saved value the catalog no longer describes still round-trips: dropping
  // it would lose a setting the dialect may read.
  for (const [key, value] of Object.entries(profile.extra)) {
    if (!(key in extra)) extra[key] = value
  }
  return {
    kind: 'form', mode: 'edit', id: profile.id, dialect: profile.dialect,
    configFields, fields, extra, password: '', probe: { status: 'idle' },
  }
}

/**
 * The staged form over one settings namespace. The scope is the single source
 * of durable truth; the dialog, the probes, and the credential facts sit
 * beside it, and every projection is rebuilt from them.
 */
export class DatabaseSettingsController {
  private readonly store: SnapshotStore<DatabasePageState>
  private readonly credentials = new Map<string, { configured: boolean; writable: boolean }>()
  private readonly probes = new Map<string, DbProbe>()
  private dialog: DbDialog = { kind: 'closed' }
  private catalog: DialectCatalog | undefined
  private saving = false
  private failed = false

  constructor(
    private readonly scope: SettingsScope<DatabaseSettings>,
    private readonly credentialFace: MysqlCredentialsFace,
    private readonly probe: (request: { id?: string, profile?: MysqlSettings }) => Promise<DbProbe>,
    private readonly loadCatalog: () => Promise<DialectCatalog>,
  ) {
    this.store = createSnapshotStore(this.projection())
    scope.subscribe(() => {
      this.publish()
      void this.refreshCredentials()
    })
    void this.refreshCredentials()
  }

  /** @returns the page's snapshot store. */
  get snapshot(): SnapshotStore<DatabasePageState> {
    return this.store
  }

  /** @returns the page's write actions. */
  actions(): DbFormActions {
    return {
      openNew: () => {
        this.dialog = { kind: 'type' }
        this.failed = false
        void this.refreshCatalog()
        this.publish()
      },
      openEdit: (draft) => {
        if (draft.kind !== 'form') return
        this.dialog = draft
        this.failed = false
        this.publish()
      },
      closeDialog: () => {
        this.dialog = { kind: 'closed' }
        this.failed = false
        this.publish()
      },
      chooseDialect: (dialect) => {
        if (this.dialog.kind !== 'type') return
        const descriptor = this.catalog?.installed.find(entry => entry.name === dialect)
        const configFields = descriptor?.configFields ?? []
        const extra: Record<string, string | number> = {}
        for (const field of configFields) extra[field.key] = field.default
        this.dialog = {
          kind: 'form', mode: 'new', id: freshId(), dialect,
          configFields, fields: blankFields(), extra, password: '', probe: { status: 'idle' },
        }
        this.publish()
      },
      editField: (field, text) => {
        if (this.dialog.kind !== 'form') return
        this.dialog = { ...this.dialog, fields: { ...this.dialog.fields, [field]: text }, probe: { status: 'idle' } }
        this.failed = false
        this.publish()
      },
      editExtra: (key, text) => {
        if (this.dialog.kind !== 'form') return
        const field = this.dialog.configFields.find(candidate => candidate.key === key)
        // A numeric field keeps its draft as text until it parses, so an empty
        // box is distinguishable from a zero the user typed.
        const value = field?.kind === 'number' && text.trim().length > 0 ? Number(text) : text
        this.dialog = {
          ...this.dialog,
          extra: { ...this.dialog.extra, [key]: value },
          probe: { status: 'idle' },
        }
        this.failed = false
        this.publish()
      },
      editPassword: (text) => {
        if (this.dialog.kind !== 'form') return
        this.dialog = { ...this.dialog, password: text }
        this.failed = false
        this.publish()
      },
      testDraft: () => { void this.testDraft() },
      saveDialog: () => { void this.saveDialog() },
      activate: (id) => { void this.activate(id) },
      testSaved: (id) => { void this.testSaved(id) },
      remove: (id) => { void this.remove(id) },
    }
  }

  private projection(): DatabasePageState {
    const snapshot = this.scope.getSnapshot()
    const value = snapshot.value
    const connections = value?.connections ?? []
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      saving: this.saving,
      failed: this.failed,
      catalog: this.catalog,
      cards: connections.map(profile => ({
        profile,
        active: profile.id === (value?.activeId ?? ''),
        passwordConfigured: this.credentials.get(profile.passwordEnv)?.configured ?? false,
        probe: this.probes.get(profile.id) ?? { status: 'idle' },
      })),
      dialog: this.dialog.kind === 'form' ? { ...this.dialog } : this.dialog,
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }

  /** Test the dialog's draft as it stands; an invalid draft is not sent. */
  private async testDraft(): Promise<void> {
    if (this.dialog.kind !== 'form' || this.dialog.probe.status === 'running') return
    const profile = dialogProfile(this.dialog)
    if (profile === undefined) return
    this.dialog = { ...this.dialog, probe: { status: 'running' } }
    this.publish()
    const probe = await this.probe({ profile })
    if (this.dialog.kind === 'form' && this.dialog.id === profile.id) {
      this.dialog = { ...this.dialog, probe }
      this.publish()
    }
  }

  /** Write the dialog's draft as a saved connection, then close the dialog. */
  private async saveDialog(): Promise<void> {
    if (this.dialog.kind !== 'form' || this.saving) return
    const profile = dialogProfile(this.dialog)
    if (profile === undefined) return
    const draft = this.dialog
    this.saving = true
    this.publish()
    try {
      const snapshot = this.scope.getSnapshot()
      const current = snapshot.value?.connections ?? []
      const connections = draft.mode === 'new'
        ? [...current, profile]
        : current.map(candidate => candidate.id === profile.id ? profile : candidate)
      // The profile list is JSON-rebuildable, but its interface carries no index
      // signature, so the whole-list write asserts the op's value type.
      const ops: SettingsPathOpView[] = [{ op: 'set', path: ['connections'], value: connections } as unknown as SettingsPathOpView]
      const activeId = snapshot.value?.activeId ?? ''
      if (draft.mode === 'new' && !current.some(candidate => candidate.id === activeId)) {
        ops.push({ op: 'set', path: ['activeId'], value: profile.id })
      }
      if (draft.password.trim().length > 0) {
        await this.credentialFace.set(profile.passwordEnv, draft.password.trim())
        await this.refreshCredentials()
      }
      await this.scope.mutate(ops)
      this.probes.delete(profile.id)
      this.dialog = { kind: 'closed' }
      this.failed = false
    } catch {
      // The Host is the only authority on what it accepted: a refusal left the
      // document as it was, so the dialog keeps its draft and reports the failure.
      this.failed = true
    } finally {
      this.saving = false
      this.publish()
    }
  }

  /** Address the tools at one saved connection. */
  private async activate(id: string): Promise<void> {
    try {
      await this.scope.mutate([{ op: 'set', path: ['activeId'], value: id }])
      this.failed = false
    } catch {
      this.failed = true
    }
    this.publish()
  }

  /** Probe one saved connection; the outcome is a value the card renders. */
  private async testSaved(id: string): Promise<void> {
    if (this.probes.get(id)?.status === 'running') return
    this.probes.set(id, { status: 'running' })
    this.publish()
    const probe = await this.probe({ id })
    this.probes.set(id, probe)
    this.publish()
  }

  /** Delete one saved connection; the active id moves to the first survivor. */
  private async remove(id: string): Promise<void> {
    const snapshot = this.scope.getSnapshot()
    const current = snapshot.value?.connections ?? []
    const connections = current.filter(candidate => candidate.id !== id)
    if (connections.length === current.length) return
    const ops: SettingsPathOpView[] = [{ op: 'set', path: ['connections'], value: connections } as unknown as SettingsPathOpView]
    if ((snapshot.value?.activeId ?? '') === id) {
      ops.push({ op: 'set', path: ['activeId'], value: connections[0]?.id ?? '' })
    }
    try {
      await this.scope.mutate(ops)
      this.probes.delete(id)
      this.failed = false
    } catch {
      this.failed = true
    }
    this.publish()
  }

  /** Read the database types the page may offer; the chooser waits for this. */
  private async refreshCatalog(): Promise<void> {
    try {
      this.catalog = await this.loadCatalog()
      this.publish()
    } catch {
      // A catalog the Host would not serve leaves the chooser empty rather
      // than offering a type no dialect can run.
      this.catalog = { installed: [], known: [] }
      this.publish()
    }
  }

  /** Read whether the Host holds values for every reference in force. */
  private async refreshCredentials(): Promise<void> {
    const refs = [...new Set((this.scope.getSnapshot().value?.connections ?? [])
      .map(profile => profile.passwordEnv))]
    await Promise.all(refs.map(async (ref) => {
      const next = await this.credentialFace.describe(ref)
      this.credentials.set(ref, next)
    }))
    this.publish()
  }
}
