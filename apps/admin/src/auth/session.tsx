import type { Permission } from '@idb-stories/schema';
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { isApiError, setCsrfToken } from '../api/client.js';
import { api } from '../api/endpoints.js';
import { qk } from '../api/queries.js';
import type { Me } from '../api/types.js';

/**
 * Текущий пользователь из GET /auth/me: права (для скрытия недоступного — проверяет сервер)
 * и CSRF-токен для изменяющих запросов.
 */
export function useMeQuery() {
  return useQuery({
    queryKey: qk.me,
    queryFn: async ({ signal }) => {
      const me = await api.me(signal);
      setCsrfToken(me.csrfToken);
      return me;
    },
    staleTime: 5 * 60_000,
    retry: (count, error) => count < 2 && isApiError(error) && (error.status === 0 || error.status >= 500),
  });
}

const MeContext = createContext<Me | null>(null);

export function MeProvider({ me, children }: { me: Me; children: ReactNode }) {
  return <MeContext.Provider value={me}>{children}</MeContext.Provider>;
}

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe вне MeProvider');
  return me;
}

export function hasPerm(me: Me, permission: Permission): boolean {
  return me.permissions.includes(permission);
}

/** Проверка права для скрытия элементов интерфейса. */
export function useCan(): (permission: Permission) => boolean {
  const me = useMe();
  return (permission) => hasPerm(me, permission);
}
