/**
 * The database settings page: the saved connections as hoverable cards, the
 * new-connection dialog with its type chooser, and per-connection probes.
 *
 * The page draws every control itself; the dialog's save button is the only
 * write path, and closing the dialog drops its draft.
 *
 * @module dsh-ds-db/src/client/DatabaseSettingsPage
 */

import { useEffect, useRef } from 'react'
import { Button, IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionCard, DbDialog, DbFormField, DbPageFace, DbProbe } from './form.ts'
import { FIELD_INVALID_KEY, dialogValid, editDraftFor, fieldInvalid } from './form.ts'
import type { DialectCatalog } from '../contract.ts'
import type { DbLocaleKey } from './locales.ts'
import styles from './page.css'

/** Props the renderer binds for this settings section. */
export type DatabaseSettingsPageProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.db'>
  & InjectFace<DbPageFace>

/** The copy key each dialog field is labelled with. */
const FIELD_LABEL_KEY: Record<DbFormField, DbLocaleKey> = {
  name: 'name',
  host: 'host',
  port: 'port',
  user: 'user',
  database: 'database',
  passwordEnv: 'passwordEnv',
  connectTimeoutMs: 'connectTimeout',
  queryTimeoutMs: 'queryTimeout',
  maxRows: 'maxRows',
}

/** The copy key each dialog field's hint is read with. */
const FIELD_HINT_KEY: Record<DbFormField, DbLocaleKey> = {
  name: 'nameHint',
  host: 'hostHint',
  port: 'portHint',
  user: 'userHint',
  database: 'databaseHint',
  passwordEnv: 'passwordEnvHint',
  connectTimeoutMs: 'connectTimeoutHint',
  queryTimeoutMs: 'queryTimeoutHint',
  maxRows: 'maxRowsHint',
}

/** The dialog fields that hint a numeric keypad. */
const NUMERIC_FIELDS: ReadonlySet<DbFormField> = new Set(['port', 'connectTimeoutMs', 'queryTimeoutMs', 'maxRows'])

/** The dialog fields rendered under the connection heading, in order. */
const CONNECTION_FIELDS: readonly DbFormField[] = ['name', 'host', 'port', 'user', 'database', 'passwordEnv']

/** The dialog fields rendered under the limits heading, in order. */
const LIMIT_FIELDS: readonly DbFormField[] = ['connectTimeoutMs', 'queryTimeoutMs', 'maxRows']

/** One probe outcome line, narrowed at render. */
function ProbeLine(props: { probe: DbProbe, t: (key: DbLocaleKey, params?: Record<string, string>) => string }) {
  const { probe } = props
  if (probe.status === 'ok') {
    return (
      <span className={`${styles.cardLine} ${styles.probeOk}`}>
        {props.t('testOk', { version: probe.version, latency: String(probe.latencyMs) })}
      </span>
    )
  }
  if (probe.status === 'failed') {
    return <span className={`${styles.cardLine} ${styles.probeFailed}`}>{props.t('testFailed', { message: probe.message })}</span>
  }
  return null
}

/** One saved connection's hoverable card. */
function Card(props: {
  card: ConnectionCard
  writable: boolean
  t: (key: DbLocaleKey, params?: Record<string, string>) => string
  onActivate: () => void
  onTest: () => void
  onEdit: () => void
  onRemove: () => void
}) {
  const { card, t } = props
  const busy = card.probe.status === 'running'
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardName}>{card.profile.name}</span>
        <span className={card.active ? `${styles.badge} ${styles.badgeActive}` : styles.badge}>
          {card.active ? t('inUse') : card.profile.dialect}
        </span>
      </div>
      <div className={styles.cardLines}>
        {/* Where the connection reaches, not the raw document: an unset port
            shows the dialect's own. */}
        <span className={styles.cardLine}>
          {`${card.resolved.host}:${String(card.resolved.port)} · ${card.resolved.user}`}
        </span>
        <span className={`${styles.cardLine} ${card.resolved.database.length === 0 ? styles.cardLineMuted : ''}`}>
          {card.resolved.database.length === 0 ? t('noDatabase') : card.resolved.database}
        </span>
        <span className={`${styles.cardLine} ${card.passwordConfigured ? styles.probeOk : styles.cardLineMuted}`}>
          {card.passwordConfigured ? t('passwordSet') : t('passwordUnset')}
        </span>
        {card.probe.status === 'running'
          ? <span className={`${styles.cardLine} ${styles.cardLineMuted}`}>{t('testing')}</span>
          : <ProbeLine probe={card.probe} t={t} />}
      </div>
      <div className={styles.cardActions}>
        {card.active
          ? null
          : <Button size="sm" disabled={!props.writable} onClick={props.onActivate}>{t('setUse')}</Button>}
        <Button size="sm" disabled={busy} onClick={props.onTest}>{t(busy ? 'testing' : 'test')}</Button>
        <Button size="sm" disabled={!props.writable} onClick={props.onEdit}>{t('edit')}</Button>
        <Button size="sm" className={styles.danger} disabled={!props.writable} onClick={props.onRemove}>{t('delete')}</Button>
      </div>
    </div>
  )
}

/** One labelled dialog field. */
function DialogField(props: {
  field: DbFormField
  dialog: Extract<DbDialog, { kind: 'form' }>
  t: (key: DbLocaleKey) => string
  disabled: boolean
  onEdit: (field: DbFormField, text: string) => void
}) {
  const { field, t } = props
  const text = props.dialog.fields[field]
  const invalid = fieldInvalid(field, text)
  return (
    <div className={styles.field}>
      <div className={styles.head}>
        <label className={styles.label} htmlFor={`dsh-db-${field}`}>{t(FIELD_LABEL_KEY[field])}</label>
      </div>
      <input
        id={`dsh-db-${field}`}
        className={styles.input}
        type="text"
        {...NUMERIC_FIELDS.has(field) ? { inputMode: 'numeric' as const } : {}}
        {...invalid ? { 'aria-invalid': true } : {}}
        value={text}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(field, event.target.value) }}
      />
      <p className={invalid ? styles.invalid : styles.hint}>{invalid ? t(FIELD_INVALID_KEY[field]) : t(FIELD_HINT_KEY[field])}</p>
    </div>
  )
}

/**
 * The dialog's type chooser: one card per registered dialect, then one card per
 * known type whose package is not installed here.
 */
function TypeChooser(props: {
  catalog: DialectCatalog | undefined
  t: (key: DbLocaleKey, params?: Record<string, string>) => string
  onChoose: (dialect: string) => void
}) {
  const { catalog, t } = props
  if (catalog === undefined) return <p className={styles.dialogHint}>{t('loading')}</p>
  if (catalog.installed.length === 0 && catalog.known.length === 0) {
    return <p className={styles.dialogHint}>{t('noDialect')}</p>
  }
  return (
    <div className={styles.typeGrid}>
      {catalog.installed.map(entry => (
        <button
          key={entry.name}
          type="button"
          className={styles.typeCard}
          onClick={() => { props.onChoose(entry.name) }}
        >
          <span className={styles.typeName}>{entry.label}</span>
          {/* The type's own line, not the plugin's: only the dialect knows what
              it connects through and what it offers. */}
          <p className={styles.typeDesc}>{entry.description ?? entry.label}</p>
          {entry.configFields.length > 0
            ? <p className={styles.typeDesc}>{t('extraFields', { count: String(entry.configFields.length) })}</p>
            : null}
        </button>
      ))}
      {catalog.known.map(entry => (
        <button key={entry.name} type="button" className={styles.typeCard} disabled>
          <span className={styles.typeName}>
            {entry.label}
            <span className={styles.badge}>{t('comingSoon')}</span>
          </span>
          <p className={styles.typeDesc}>{t('installHint', { package: entry.package })}</p>
        </button>
      ))}
    </div>
  )
}

/** The dialog's form: the connection fields, the password, and the probe. */
function FormDialog(props: {
  dialog: Extract<DbDialog, { kind: 'form' }>
  saving: boolean
  t: (key: DbLocaleKey, params?: Record<string, string>) => string
  onEditField: (field: DbFormField, text: string) => void
  onEditExtra: (key: string, text: string) => void
  onEditPassword: (text: string) => void
  onTest: () => void
  onSave: () => void
  onClose: () => void
}) {
  const { dialog, t } = props
  const valid = dialogValid(dialog)
  return (
    <>
      <h3 className={styles.heading}>{t('connectionHeading')}</h3>
      {CONNECTION_FIELDS.map(field => (
        <DialogField key={field} field={field} dialog={dialog} t={t} disabled={props.saving} onEdit={props.onEditField} />
      ))}
      {dialog.configFields.map(field => (
        <div className={styles.field} key={field.key}>
          <div className={styles.head}>
            <label className={styles.label} htmlFor={`dsh-db-extra-${field.key}`}>
              {field.label ?? field.key}
              {field.required ? <span className={styles.required}>*</span> : null}
            </label>
          </div>
          <input
            id={`dsh-db-extra-${field.key}`}
            className={styles.input}
            type={field.kind === 'number' ? 'text' : 'text'}
            {...field.kind === 'number' ? { inputMode: 'numeric' as const } : {}}
            value={String(dialog.extra[field.key] ?? '')}
            disabled={props.saving}
            onChange={(event) => { props.onEditExtra(field.key, event.target.value) }}
          />
          <p className={styles.hint}>{field.required ? t('requiredHint') : t('optionalHint')}</p>
        </div>
      ))}
      <div className={styles.field}>
        <div className={styles.head}>
          <label className={styles.label} htmlFor="dsh-db-password">{t('password')}</label>
        </div>
        <input
          id="dsh-db-password"
          className={styles.input}
          type="password"
          autoComplete="new-password"
          value={dialog.password}
          disabled={props.saving}
          onChange={(event) => { props.onEditPassword(event.target.value) }}
        />
        <p className={styles.hint}>{t('passwordHint')}</p>
      </div>
      <h3 className={styles.heading}>{t('limitsHeading')}</h3>
      {LIMIT_FIELDS.map(field => (
        <DialogField key={field} field={field} dialog={dialog} t={t} disabled={props.saving} onEdit={props.onEditField} />
      ))}
      {dialog.probe.status === 'running'
        ? null
        : <div className={styles.cardActions}><ProbeLine probe={dialog.probe} t={t} /></div>}
      <div className={styles.dialogFooter}>
        <Button size="sm" disabled={dialog.probe.status === 'running' || !valid} onClick={props.onTest}>
          {t(dialog.probe.status === 'running' ? 'testing' : 'test')}
        </Button>
        <span className={styles.footerSpacer} />
        <Button size="sm" variant="outline" disabled={props.saving} onClick={props.onClose}>{t('cancel')}</Button>
        <Button size="sm" variant="outline" disabled={!valid || props.saving} onClick={props.onSave}>
          {t(props.saving ? 'saving' : 'save')}
        </Button>
      </div>
    </>
  )
}

/**
 * Render the database connections page.
 * @param props - framework seats for the section, the page snapshot, and its actions.
 * @returns the page, or the unavailable notice while the host serves no namespace.
 */
export function DatabaseSettingsPage(props: DatabaseSettingsPageProps) {
  const { t } = props
  const state = props.useDbPage(snapshot => snapshot)
  const close = useRef(props.closeDialog)
  close.current = props.closeDialog
  useEffect(() => () => { close.current() }, [])

  if (!state.available) return <p className={styles.unavailable} role="status">{t('unavailable')}</p>
  const dialog = state.dialog
  return (
    <section className={styles.page}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>{t('title')}</h2>
          <p className={styles.description}>{t('description')}</p>
        </div>
        {/* The settings shell's own actions are the bordered `outline` family;
            `primary` is the plugin-manager page's capsule and reads as a
            different surface here. */}
        <Button
          size="sm"
          variant="outline"
          className={styles.newButton}
          icon={<IconPlusOutline16 size={13} />}
          disabled={!state.writable || state.saving}
          onClick={props.openNew}
        >
          {t('newConnection')}
        </Button>
      </div>
      {!state.writable ? <p className={styles.readOnly} role="status">{t('readOnly')}</p> : null}
      {state.failed ? <p className={styles.failed} role="status">{t('saveFailed')}</p> : null}

      <div className={styles.cards}>
        {state.cards.map(card => (
          <Card
            key={card.profile.id}
            card={card}
            writable={state.writable}
            t={t}
            onActivate={() => { props.activate(card.profile.id) }}
            onTest={() => { props.testSaved(card.profile.id) }}
            onEdit={() => { props.openEdit(editDraftFor(card.profile, state.catalog)) }}
            onRemove={() => {
              if (window.confirm(t('deleteConfirm', { name: card.profile.name }))) props.remove(card.profile.id)
            }}
          />
        ))}
      </div>
      {state.cards.length === 0 ? <p className={styles.empty}>{t('empty')}</p> : null}

      {dialog.kind !== 'closed'
        ? (
            <div className={styles.overlay} onClick={(event) => { if (event.target === event.currentTarget) props.closeDialog() }}>
              <div className={styles.dialog} role="dialog" aria-modal="true">
                {dialog.kind === 'type'
                  ? (
                      <>
                        <h2 className={styles.dialogTitle}>{t('dialectTitle')}</h2>
                        <p className={styles.dialogHint}>{t('dialectHint')}</p>
                        <TypeChooser catalog={state.catalog} t={t} onChoose={props.chooseDialect} />
                      </>
                    )
                  : (
                      <>
                        <h2 className={styles.dialogTitle}>
                          {dialog.mode === 'new' ? t('newConnection') : `${t('edit')} · ${dialog.fields.name}`}
                        </h2>
                        <FormDialog
                          dialog={dialog}
                          saving={state.saving}
                          t={t}
                          onEditField={props.editField}
                          onEditExtra={props.editExtra}
                          onEditPassword={props.editPassword}
                          onTest={props.testDraft}
                          onSave={props.saveDialog}
                          onClose={props.closeDialog}
                        />
                      </>
                    )}
              </div>
            </div>
          )
        : null}
    </section>
  )
}
