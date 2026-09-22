/**
 * Staged form model behind the MySQL settings page.
 *
 * A page edit is a draft: nothing is written to the Host until the user saves,
 * because every settings write is a durable revision-fenced document mutation.
 * The password control is the one draft that is not part of the section — it is
 * written through the credential domain, keyed by the reference the section
 * names, and never read back.
 *
 * @module dsh-ds-db/src/client/form
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DEFAULT_PASSWORD_REF, MYSQL_SETTINGS_FIELDS, type MysqlSettings, type MysqlSettingsField } from '../contract.ts'

/** What one field's saved draft performs. */
type FieldWrite = { kind: 'set'; value: string | number } | { kind: 'clear' }

/** How one field converts between its stored value and its draft text. */
interface FieldSpec {
  /** Render the effective value as draft text. */
  format: (value: MysqlSettings) => string
  /** The write this draft performs, or undefined when the field cannot accept it. */
  parse: (text: string) => FieldWrite | undefined
}

/** One field as the page renders it. */
export interface MysqlFieldState {
  /** Draft text the control shows. */
  text: string
  /** Whether saving would leave a user-layer entry for this field. */
  overridden: boolean
  /** Whether the draft is not a value this field accepts, which blocks the save. */
  invalid: boolean
}

/** The connection probe's state, owned by the page's Test button. */
export type MysqlProbe =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ok'; version: string; latencyMs: number }
  | { status: 'failed'; message: string }

/** Everything the page renders. */
export interface MysqlPageState {
  /** False until the Host serves this settings namespace. */
  available: boolean
  /** Whether the Host settings document accepts writes. */
  writable: boolean
  /** Whether the form holds edits a save would write. */
  dirty: boolean
  /** Whether any draft is not a value its field accepts, which blocks the save. */
  invalid: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save did not land as staged; cleared by the next edit or save. */
  failed: boolean
  /** One state per connection field, in page order. */
  fields: Record<MysqlSettingsField, MysqlFieldState>
  /** The write-only password control. */
  password: {
    /** Draft text; always blank on load because no response carries the literal. */
    text: string
    /** Whether the Host reports a stored value for the reference. */
    configured: boolean
    /** Whether the credential store accepts a write for it. */
    writable: boolean
  }
  /** The last connection probe. */
  probe: MysqlProbe
}

/** The credential-domain face the page writes and describes through. */
export interface MysqlCredentialsFace {
  /** Presence and writability facts for one reference; never its value. */
  describe: (ref: string) => Promise<{ configured: boolean; writable: boolean }>
  /** Store one literal under one reference. */
  set: (ref: string, value: string) => Promise<void>
}

/** Write actions the page's slot entry injects. */
export interface MysqlFormActions {
  /** Stage draft text for one field. */
  edit: (field: MysqlSettingsField, text: string) => void
  /** Stage a clear, so saving lets the field re-inherit the composition layer. */
  resetField: (field: MysqlSettingsField) => void
  /** Stage the password literal. */
  editPassword: (text: string) => void
  /** Write every staged edit, then re-seed from what the Host accepted. */
  save: () => void
  /** Drop every staged edit. */
  discard: () => void
  /** Probe the saved connection. */
  test: () => void
}

/** Everything the page's slot entry injects. */
export interface MysqlPageFace extends MysqlFormActions {
  hooks: {
    /** Page snapshot, bound by the renderer as `useMysqlPage`. */
    mysqlPage: SnapshotStore<MysqlPageState>
  }
}

/** Whether a draft text is a positive whole number. */
function positiveInteger(text: string): number | undefined {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  return value >= 1 ? value : undefined
}

/** The per-field conversion rules; the keys are the section's own field names. */
const SPECS: Record<MysqlSettingsField, FieldSpec> = {
  host: {
    format: settings => settings.host,
    parse: text => text.trim().length === 0 ? undefined : { kind: 'set', value: text.trim() },
  },
  port: {
    format: settings => String(settings.port),
    parse: (text) => {
      const value = positiveInteger(text)
      return value === undefined || value > 65535 ? undefined : { kind: 'set', value }
    },
  },
  user: {
    format: settings => settings.user,
    parse: text => text.trim().length === 0 ? undefined : { kind: 'set', value: text.trim() },
  },
  database: {
    // An empty database is meaningful: it means every tool call names its own.
    format: settings => settings.database,
    parse: (text) => {
      const trimmed = text.trim()
      return trimmed.length === 0 ? { kind: 'clear' } : { kind: 'set', value: trimmed }
    },
  },
  passwordEnv: {
    format: settings => settings.passwordEnv,
    parse: (text) => {
      const trimmed = text.trim()
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) ? { kind: 'set', value: trimmed } : undefined
    },
  },
  connectTimeoutMs: {
    format: settings => String(settings.connectTimeoutMs),
    parse: (text) => {
      const value = positiveInteger(text)
      return value === undefined ? undefined : { kind: 'set', value }
    },
  },
  queryTimeoutMs: {
    format: settings => String(settings.queryTimeoutMs),
    parse: (text) => {
      const value = positiveInteger(text)
      return value === undefined ? undefined : { kind: 'set', value }
    },
  },
  maxRows: {
    format: settings => String(settings.maxRows),
    parse: (text) => {
      const value = positiveInteger(text)
      return value === undefined ? undefined : { kind: 'set', value }
    },
  },
}

/**
 * The staged form over one settings namespace.
 *
 * The scope is the single source of durable truth: drafts sit beside it, and
 * every projection is rebuilt from the two together, so a Host-side change
 * that lands while a draft is open keeps both facts visible.
 */
export class MysqlSettingsController {
  private readonly store: SnapshotStore<MysqlPageState>
  private readonly drafts = new Map<MysqlSettingsField, string>()
  private passwordDraft = ''
  private password = { ref: '', configured: false, writable: true }
  private probeState: MysqlProbe = { status: 'idle' }
  private saving = false
  private failed = false

  /**
   * @param scope - the bound scope for the MySQL settings namespace.
   * @param credentials - the credential domain, addressed by the section's reference.
   * @param probe - the Host's connection probe.
   */
  constructor(
    private readonly scope: SettingsScope<MysqlSettings>,
    private readonly credentials: MysqlCredentialsFace,
    private readonly probe: () => Promise<MysqlProbe>,
  ) {
    this.store = createSnapshotStore(this.projection())
    scope.subscribe(() => {
      this.publish()
      void this.refreshCredential()
    })
    void this.refreshCredential()
  }

  /** @returns the page's snapshot store. */
  get snapshot(): SnapshotStore<MysqlPageState> {
    return this.store
  }

  /** @returns the page's write actions. */
  actions(): MysqlFormActions {
    return {
      edit: (field, text) => {
        this.drafts.set(field, text)
        this.failed = false
        this.publish()
      },
      resetField: (field) => {
        this.drafts.set(field, '')
        this.failed = false
        this.publish()
      },
      editPassword: (text) => {
        this.passwordDraft = text
        this.failed = false
        this.publish()
      },
      save: () => { void this.save() },
      discard: () => { this.discard() },
      test: () => { void this.test() },
    }
  }

  private projection(): MysqlPageState {
    const snapshot = this.scope.getSnapshot()
    const value = snapshot.value
    const user = isRecord(snapshot.user) ? snapshot.user : {}
    const fields = {} as Record<MysqlSettingsField, MysqlFieldState>
    for (const field of MYSQL_SETTINGS_FIELDS) {
      const draft = this.drafts.get(field)
      fields[field] = {
        text: draft ?? (value === undefined ? '' : SPECS[field].format(value)),
        overridden: draft === undefined
          ? Object.hasOwn(user, field)
          : SPECS[field].parse(draft)?.kind === 'set',
        invalid: draft !== undefined && SPECS[field].parse(draft) === undefined,
      }
    }
    const dirtyFields = MYSQL_SETTINGS_FIELDS.some((field) => {
      const draft = this.drafts.get(field)
      return draft !== undefined && (value === undefined || draft !== SPECS[field].format(value))
    })
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: dirtyFields || this.passwordDraft.trim().length > 0,
      invalid: MYSQL_SETTINGS_FIELDS.some(field => this.drafts.get(field) !== undefined
        && SPECS[field].parse(this.drafts.get(field) ?? '') === undefined),
      saving: this.saving,
      failed: this.failed,
      fields,
      password: {
        text: this.passwordDraft,
        configured: this.password.configured,
        writable: this.password.writable,
      },
      probe: this.probeState,
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }

  private discard(): void {
    this.drafts.clear()
    this.passwordDraft = ''
    this.failed = false
    this.publish()
  }

  /** Write every staged edit, then re-seed from what the Host accepted. */
  private async save(): Promise<void> {
    const ops = this.stagedOps()
    if (ops === undefined) return
    this.saving = true
    this.publish()
    try {
      if (this.passwordDraft.trim().length > 0) {
        await this.credentials.set(this.reference(), this.passwordDraft.trim())
        this.passwordDraft = ''
        await this.refreshCredential()
        if (!this.password.configured) throw new Error('the credential store did not keep the password')
      }
      if (ops.length > 0) await this.scope.mutate(ops)
      this.drafts.clear()
      this.failed = false
    } catch {
      // The Host is the only authority on what it accepted: a refusal left the
      // document as it was, so the page keeps the drafts and reports the failure.
      this.failed = true
    } finally {
      this.saving = false
      this.publish()
    }
  }

  /** The staged edits as path operations, or undefined while any draft is invalid. */
  private stagedOps(): SettingsPathOpView[] | undefined {
    const ops: SettingsPathOpView[] = []
    for (const [field, draft] of this.drafts) {
      const write = SPECS[field].parse(draft)
      if (write === undefined) return undefined
      ops.push(write.kind === 'clear'
        ? { op: 'unset', path: [field] }
        : { op: 'set', path: [field], value: write.value })
    }
    return ops
  }

  /** Probe the saved connection; the outcome is a value the page renders. */
  private async test(): Promise<void> {
    this.probeState = { status: 'running' }
    this.publish()
    this.probeState = await this.probe()
    this.publish()
  }

  /** The reference the password control writes to: the draft's, else the stored one. */
  private reference(): string {
    const draft = this.drafts.get('passwordEnv')
    const parsed = draft === undefined ? undefined : SPECS.passwordEnv.parse(draft)
    if (parsed !== undefined && parsed.kind === 'set' && typeof parsed.value === 'string') return parsed.value
    return this.scope.getSnapshot().value?.passwordEnv ?? DEFAULT_PASSWORD_REF
  }

  /** Read whether the Host currently holds a value for the reference in force. */
  private async refreshCredential(): Promise<void> {
    const ref = this.reference()
    const next = await this.credentials.describe(ref)
    if (ref !== this.reference()) return
    if (next.configured === this.password.configured && next.writable === this.password.writable
      && ref === this.password.ref) return
    this.password = { ref, configured: next.configured, writable: next.writable }
    this.publish()
  }
}

/** Whether a value is a plain record the user layer can be read from. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
