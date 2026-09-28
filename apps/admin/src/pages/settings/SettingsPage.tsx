import { KILL_SWITCH_CONFIRMATION, normalizeDomain, validateAllowlist } from '@idb-stories/schema';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState, type FormEvent } from 'react';
import { api } from '../../api/endpoints.js';
import { qk, useSettings } from '../../api/queries.js';
import type { CtaAllowlist, SettingsDto } from '../../api/types.js';
import { useCan } from '../../auth/session.js';
import { ErrorMessage } from '../../components/ErrorMessage.js';
import { Modal } from '../../components/Modal.js';
import { Loading, Notice, PageHeader, QueryError } from '../../components/Status.js';
import { ru } from '../../i18n/ru.js';
import { useNotice } from '../../lib/hooks.js';

/** Настройки: kill switch ленты и allowlist CTA. Меняет только администратор (settings:write). */
export function SettingsPage() {
  const can = useCan();
  const settings = useSettings();
  const writable = can('settings:write');

  return (
    <div className="stack">
      <title>{ru.app.pageTitle(ru.settings.title)}</title>
      <PageHeader title={ru.settings.title}>{!writable ? <p className="muted">{ru.settings.readOnly}</p> : null}</PageHeader>
      {settings.isPending ? (
        <Loading />
      ) : settings.isError ? (
        <QueryError error={settings.error} onRetry={() => void settings.refetch()} />
      ) : (
        <>
          <KillSwitchCard feedEnabled={settings.data.feedEnabled} writable={writable} />
          <AllowlistCard allowlist={settings.data.ctaAllowlist} writable={writable} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kill switch (раздел 10.8): подтверждение повторным вводом слова
// ---------------------------------------------------------------------------

export function KillSwitchCard({ feedEnabled, writable }: { feedEnabled: boolean; writable: boolean }) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useNotice();
  const titleId = useId();
  return (
    <section className={`card stack killswitch${feedEnabled ? '' : ' killswitch--off'}`} aria-labelledby={titleId}>
      <h2 id={titleId} className="section-title">
        {ru.settings.killTitle}
      </h2>
      <p>{ru.settings.killText}</p>
      <p className="killswitch__state" role="status">
        <span className={`dot ${feedEnabled ? 'dot--on' : 'dot--off'}`} aria-hidden="true" />
        <strong>{feedEnabled ? ru.settings.feedOn : ru.settings.feedOff}</strong>
      </p>
      {writable ? (
        <div>
          <button
            type="button"
            className={feedEnabled ? 'btn btn--danger' : 'btn btn--primary'}
            onClick={() => {
              setNotice(null);
              setOpen(true);
            }}
          >
            {feedEnabled ? ru.settings.disable : ru.settings.enable}
          </button>
        </div>
      ) : null}
      <Notice>{notice}</Notice>
      {open ? (
        <KillSwitchDialog
          enable={!feedEnabled}
          onClose={() => setOpen(false)}
          onDone={(s) => {
            setOpen(false);
            setNotice(s.feedEnabled ? ru.settings.feedOn : ru.settings.feedOff);
          }}
        />
      ) : null}
    </section>
  );
}

function KillSwitchDialog({
  enable,
  onClose,
  onDone,
}: {
  enable: boolean;
  onClose: () => void;
  onDone: (settings: SettingsDto) => void;
}) {
  const client = useQueryClient();
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState('');
  const word = enable ? KILL_SWITCH_CONFIRMATION.enable : KILL_SWITCH_CONFIRMATION.disable;
  const matches = typed.trim() === word;

  const mutation = useMutation({
    mutationFn: () => api.setFeedEnabled(enable, typed.trim()),
    onSuccess: (settings) => {
      client.setQueryData(qk.settings, settings);
      onDone(settings);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (matches && !mutation.isPending) mutation.mutate();
  };

  return (
    <Modal
      title={enable ? ru.settings.confirmEnableTitle : ru.settings.confirmDisableTitle}
      onClose={onClose}
      busy={mutation.isPending}
      initialFocusRef={inputRef}
    >
      <form className="stack" onSubmit={submit}>
        <p>{enable ? ru.settings.confirmEnableText : ru.settings.confirmDisableText}</p>
        <div className="field">
          <label className="field__label" htmlFor={`${id}-word`}>
            {ru.settings.confirmPrompt(word)}
          </label>
          <input
            ref={inputRef}
            id={`${id}-word`}
            type="text"
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
            aria-invalid={typed !== '' && !matches ? true : undefined}
            aria-describedby={typed !== '' && !matches ? `${id}-mismatch` : undefined}
          />
          {typed !== '' && !matches ? (
            <p id={`${id}-mismatch`} className="field__hint">
              {ru.settings.confirmMismatch}
            </p>
          ) : null}
        </div>
        <ErrorMessage error={mutation.error} />
        <div className="actions actions--end">
          <button type="button" className="btn" onClick={onClose} disabled={mutation.isPending}>
            {ru.common.cancel}
          </button>
          <button
            type="submit"
            className={enable ? 'btn btn--primary' : 'btn btn--danger'}
            disabled={!matches || mutation.isPending}
          >
            {mutation.isPending ? ru.settings.applying : enable ? ru.settings.confirmEnable : ru.settings.confirmDisable}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Allowlist CTA (раздел 10.4)
// ---------------------------------------------------------------------------

function sameList(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function AllowlistCard({ allowlist, writable }: { allowlist: CtaAllowlist; writable: boolean }) {
  const client = useQueryClient();
  const titleId = useId();
  const [schemes, setSchemes] = useState<string[]>(allowlist.deeplinkSchemes);
  const [domains, setDomains] = useState<string[]>(allowlist.urlDomains);
  const [notice, setNotice] = useNotice();
  const dirty = !sameList(schemes, allowlist.deeplinkSchemes) || !sameList(domains, allowlist.urlDomains);

  const save = useMutation({
    mutationFn: () => api.updateAllowlist({ deeplinkSchemes: schemes, urlDomains: domains }),
    onMutate: () => setNotice(null),
    onSuccess: (settings) => {
      client.setQueryData(qk.settings, settings);
      // Сервер нормализует и сортирует значения — показываем сохранённый вариант.
      setSchemes(settings.ctaAllowlist.deeplinkSchemes);
      setDomains(settings.ctaAllowlist.urlDomains);
      setNotice(ru.settings.allowlistSaved);
      void client.invalidateQueries({ queryKey: ['preview'] });
    },
  });

  return (
    <section className="card stack" aria-labelledby={titleId}>
      <h2 id={titleId} className="section-title">
        {ru.settings.allowlistTitle}
      </h2>
      <p>{ru.settings.allowlistText}</p>
      {writable ? <p className="alert alert--warning">{ru.settings.allowlistNarrowWarning}</p> : null}
      <div className="allowlist-grid">
        <ListEditor
          title={ru.settings.schemes}
          empty={ru.settings.schemesEmpty}
          items={schemes}
          onChange={setSchemes}
          writable={writable}
          inputLabel={ru.settings.newScheme}
          placeholder={ru.settings.schemePlaceholder}
          addLabel={ru.settings.addScheme}
          normalize={(raw) => {
            const value = raw.trim().toLowerCase().replace(/:\/*$/, '');
            const check = validateAllowlist({ deeplinkSchemes: [value], urlDomains: [] });
            return check.ok ? { ok: true, value: check.allowlist.deeplinkSchemes[0] ?? value } : { ok: false, message: check.errors[0] ?? ru.validation.invalid };
          }}
        />
        <ListEditor
          title={ru.settings.domains}
          hint={ru.settings.domainHint}
          empty={ru.settings.domainsEmpty}
          items={domains}
          onChange={setDomains}
          writable={writable}
          inputLabel={ru.settings.newDomain}
          placeholder={ru.settings.domainPlaceholder}
          addLabel={ru.settings.addDomain}
          normalize={(raw) => {
            const value = normalizeDomain(raw);
            return value ? { ok: true, value } : { ok: false, message: ru.validation.invalidFormat };
          }}
        />
      </div>
      <ErrorMessage error={save.error} />
      <Notice>{notice}</Notice>
      {writable ? (
        <div className="actions">
          <button type="button" className="btn btn--primary" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            {save.isPending ? ru.common.saving : ru.settings.saveAllowlist}
          </button>
          {dirty ? (
            <>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setSchemes(allowlist.deeplinkSchemes);
                  setDomains(allowlist.urlDomains);
                }}
                disabled={save.isPending}
              >
                {ru.common.cancel}
              </button>
              <span className="muted small">{ru.settings.allowlistDirty}</span>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

type Normalized = { ok: true; value: string } | { ok: false; message: string };

interface ListEditorProps {
  title: string;
  hint?: string;
  empty: string;
  items: string[];
  onChange: (items: string[]) => void;
  writable: boolean;
  inputLabel: string;
  placeholder: string;
  addLabel: string;
  normalize: (raw: string) => Normalized;
}

function ListEditor({ title, hint, empty, items, onChange, writable, inputLabel, placeholder, addLabel, normalize }: ListEditorProps) {
  const id = useId();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim()) return;
    const res = normalize(value);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    if (items.includes(res.value)) {
      setError(ru.settings.duplicate);
      return;
    }
    setError(null);
    setValue('');
    onChange([...items, res.value].sort());
  };

  return (
    <div className="stack stack--tight">
      <h3 className="subsection-title">{title}</h3>
      {hint ? <p className="field__hint">{hint}</p> : null}
      {items.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul className="chips" aria-label={title}>
          {items.map((item) => (
            <li key={item} className="chip">
              <span className="mono">{item}</span>
              {writable ? (
                <button
                  type="button"
                  className="chip__remove"
                  onClick={() => onChange(items.filter((x) => x !== item))}
                  aria-label={ru.settings.removeItem(item)}
                >
                  <span aria-hidden="true">×</span>
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {writable ? (
        <form className="field" onSubmit={add}>
          <label className="field__label field__label--small" htmlFor={`${id}-new`}>
            {inputLabel}
          </label>
          <div className="input-row">
            <input
              id={`${id}-new`}
              type="text"
              value={value}
              placeholder={placeholder}
              spellCheck={false}
              autoComplete="off"
              maxLength={253}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
            />
            <button type="submit" className="btn">
              {addLabel}
            </button>
          </div>
          {error ? (
            <p id={`${id}-error`} className="field__error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
