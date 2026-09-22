/**
 * The MySQL settings page: the connection fields, the write-only password
 * control, the execution limits, and the connection probe.
 *
 * The page draws every control itself and stages every edit; the save button is
 * the only write path, and leaving the page drops the drafts.
 *
 * @module dsh-ds-db/src/client/MysqlSettingsPage
 */

import { useEffect, useRef } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MysqlSettingsField } from '../contract.ts'
import type { MysqlFieldState, MysqlPageFace } from './form.ts'
import type { MysqlLocaleKey } from './locales.ts'
import styles from './page.css'

/** Props the renderer binds for this settings section. */
export type MysqlSettingsPageProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.mysql'>
  & InjectFace<MysqlPageFace>

/** One editable field's chrome. */
interface FieldProps {
  /** Stable id associating the label with its control. */
  id: string
  /** Visible label. */
  label: string
  /** One-line explanation under the control. */
  hint: string
  /** Copy for the overridden badge. */
  overriddenLabel: string
  /** Copy for the reset control. */
  resetLabel: string
  /** Copy shown in place of the hint while the draft is invalid. */
  invalidLabel: string
  /** Field state: draft text, override marker, and validity. */
  state: MysqlFieldState
  /** Disables the control (read-only document, or unavailable namespace). */
  disabled: boolean
  /** Hints a numeric keypad without narrowing what the control accepts. */
  numeric?: boolean
  /** Stage draft text. */
  onEdit: (text: string) => void
  /** Stage a clear so the field re-inherits the composition layer. */
  onReset: () => void
}

/**
 * Render one labelled field.
 * @param props - the field's copy, its staged state, and its edit actions.
 * @returns the labelled control.
 */
function Field(props: FieldProps) {
  const message = props.state.invalid ? props.invalidLabel : props.hint
  const messageId = `${props.id}-message`
  return (
    <div className={styles.field}>
      <div className={styles.head}>
        <label className={styles.label} htmlFor={props.id}>{props.label}</label>
        {props.state.overridden
          ? (
            <span className={styles.badges}>
              <span className={styles.badge}>{props.overriddenLabel}</span>
              <button type="button" className={styles.reset} disabled={props.disabled} onClick={props.onReset}>
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
      </div>
      <input
        id={props.id}
        className={styles.input}
        type="text"
        {...props.numeric === true ? { inputMode: 'numeric' as const } : {}}
        {...props.state.invalid ? { 'aria-invalid': true } : {}}
        aria-describedby={messageId}
        value={props.state.text}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
      <p id={messageId} className={props.state.invalid ? styles.invalid : styles.hint}>{message}</p>
    </div>
  )
}

/**
 * Render the MySQL connection page.
 * @param props - framework seats for the section, the page snapshot, and its actions.
 * @returns the page, or the unavailable notice while the host serves no namespace.
 */
export function MysqlSettingsPage(props: MysqlSettingsPageProps) {
  const { t } = props
  const state = props.useMysqlPage(snapshot => snapshot)
  const discard = useRef(props.discard)
  discard.current = props.discard
  useEffect(() => () => { discard.current() }, [])

  if (!state.available) return <p className={styles.unavailable} role="status">{t('unavailable')}</p>
  const disabled = !state.writable
  const probe = state.probe
  const field = (name: MysqlSettingsField, label: MysqlLocaleKey, hint: MysqlLocaleKey, invalid: MysqlLocaleKey, numeric = false) => (
    <Field
      id={`dsh-mysql-${name}`}
      label={t(label)}
      hint={t(hint)}
      invalidLabel={t(invalid)}
      overriddenLabel={t('overridden')}
      resetLabel={t('reset')}
      state={state.fields[name]}
      disabled={disabled}
      numeric={numeric}
      onEdit={(text) => { props.edit(name, text) }}
      onReset={() => { props.resetField(name) }}
    />
  )

  return (
    <section className={styles.page}>
      <h2 className={styles.title}>{t('title')}</h2>
      <p className={styles.description}>{t('description')}</p>
      {!state.writable ? <p className={styles.readOnly} role="status">{t('readOnly')}</p> : null}

      <h3 className={styles.heading}>{t('connectionHeading')}</h3>
      {field('host', 'host', 'hostHint', 'invalidText')}
      {field('port', 'port', 'portHint', 'invalidNumber', true)}
      {field('user', 'user', 'userHint', 'invalidText')}
      {field('database', 'database', 'databaseHint', 'invalidText')}
      <Field
        id="dsh-mysql-password"
        label={t('password')}
        hint={t('passwordHint')}
        invalidLabel={t('invalidText')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        state={{ text: state.password.text, overridden: false, invalid: false }}
        // The credential store has its own refusals: a password sourced from the
        // process environment cannot be rewritten from a page.
        disabled={!state.password.writable}
        onEdit={props.editPassword}
        onReset={() => { props.editPassword('') }}
      />
      <p className={state.password.configured ? styles.probeOk : styles.hint} role="status">
        {state.password.configured ? t('passwordSet') : t('passwordUnset')}
      </p>
      {field('passwordEnv', 'passwordEnv', 'passwordEnvHint', 'invalidReference')}

      <h3 className={styles.heading}>{t('limitsHeading')}</h3>
      {field('connectTimeoutMs', 'connectTimeout', 'connectTimeoutHint', 'invalidNumber', true)}
      {field('queryTimeoutMs', 'queryTimeout', 'queryTimeoutHint', 'invalidNumber', true)}
      {field('maxRows', 'maxRows', 'maxRowsHint', 'invalidNumber', true)}

      <div className={styles.probe}>
        <button
          type="button"
          className={styles.test}
          disabled={probe.status === 'running'}
          onClick={props.test}
        >
          {t(probe.status === 'running' ? 'testing' : 'test')}
        </button>
        {probe.status === 'ok'
          ? (
            <p className={styles.probeOk} role="status">
              {t('testOk', { version: probe.version, latency: String(probe.latencyMs) })}
            </p>
          )
          : null}
        {probe.status === 'failed'
          ? <p className={styles.probeFailed} role="status">{t('testFailed', { message: probe.message })}</p>
          : null}
      </div>

      <div className={styles.footer}>
        {state.failed ? <p className={styles.failed} role="status">{t('saveFailed')}</p> : null}
        <button
          type="button"
          className={styles.save}
          disabled={!state.dirty || state.invalid || state.saving}
          onClick={props.save}
        >
          {t(state.saving ? 'saving' : 'save')}
        </button>
      </div>
    </section>
  )
}
