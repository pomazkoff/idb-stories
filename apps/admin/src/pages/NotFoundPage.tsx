import { Link, useRouteError } from 'react-router';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { ru } from '../i18n/ru.js';

export function NotFoundPage() {
  return (
    <div className="card stack">
      <title>{ru.app.pageTitle(ru.errors.notFoundTitle)}</title>
      <h1 className="page-title">{ru.errors.notFoundTitle}</h1>
      <p>{ru.errors.notFoundText}</p>
      <p>
        <Link to="/groups">{ru.errors.toGroups}</Link>
      </p>
    </div>
  );
}

/** Ошибка рендера маршрута: без стеков и внутренних сообщений. */
export function RouteErrorPage() {
  const error = useRouteError();
  return (
    <div className="center-screen">
      <div className="card card--narrow stack">
        <ErrorMessage error={error} />
        <p>
          <a href="/groups">{ru.errors.toGroups}</a>
        </p>
      </div>
    </div>
  );
}
