import { useSearchParams } from 'react-router';
import { startLogin } from '../api/client.js';
import { ru } from '../i18n/ru.js';

/** Страница входа: полный переход на SSO. Сюда же сервер возвращает при ошибке SSO (?error=sso). */
export function LoginPage() {
  const [params] = useSearchParams();
  const error = params.get('error');
  const returnTo = params.get('returnTo') ?? '/';
  const message = error === 'sso' ? ru.auth.ssoError : error === 'loop' ? ru.auth.loopError : null;

  return (
    <div className="center-screen">
      <title>{ru.app.pageTitle(ru.auth.loginTitle)}</title>
      <main className="card card--narrow stack">
        <p className="brand">{ru.app.name}</p>
        <h1 className="page-title">{ru.auth.loginTitle}</h1>
        {message ? (
          <div className="alert alert--error" role="alert">
            <p className="alert__text">{message}</p>
          </div>
        ) : null}
        <p>{ru.auth.loginText}</p>
        <div>
          <button type="button" className="btn btn--primary btn--large" onClick={() => startLogin(returnTo)}>
            {ru.auth.loginButton}
          </button>
        </div>
      </main>
    </div>
  );
}
