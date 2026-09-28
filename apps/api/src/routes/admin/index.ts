import { withTimeout } from '@idb-stories/adapters';
import { adapterErrorsTotal } from '@idb-stories/core';
import * as c from '@idb-stories/schema/contracts';
import type { SessionStore } from '../../auth/session.js';
import type { AppDeps } from '../../context.js';
import { AppError } from '../../http/errors.js';
import { route, type RouteDef } from '../../http/routes.js';
import { queryAuditLog } from '../../services/audit-query.js';
import { GroupsService } from '../../services/groups.js';
import { MediaService } from '../../services/media.js';
import { SettingsAdminService } from '../../services/settings-admin.js';
import { groupStats } from '../../services/stats.js';
import { UsersService } from '../../services/users.js';
import { WorkflowService } from '../../services/workflow.js';
import { authRoutes } from './auth.js';

export function adminRoutes(deps: AppDeps, sessions: SessionStore): RouteDef[] {
  const groups = new GroupsService(deps);
  const workflow = new WorkflowService(deps, groups);
  const media = new MediaService(deps);
  const users = new UsersService(deps, sessions);
  const settings = new SettingsAdminService(deps);

  return [
    ...authRoutes(deps, sessions),

    // Группы и слайды
    route(c.listGroups, ({ query }) => groups.list(query)),
    route(c.createGroup, ({ body, actor, audit }) => groups.create(body, actor, audit)),
    route(c.getGroup, ({ params, actor }) => groups.get(params.id, actor)),
    route(c.updateGroup, ({ params, body, actor, audit }) =>
      groups.update(params.id, body, actor, audit),
    ),
    route(c.deleteGroup, async ({ params, audit, reply }) => {
      await groups.remove(params.id, audit);
      reply.code(204);
      return undefined;
    }),
    route(c.duplicateGroup, ({ params, actor, audit }) =>
      groups.duplicate(params.id, actor, audit),
    ),
    route(c.createSlide, ({ params, body, actor, audit }) =>
      groups.addSlide(params.id, body, actor, audit),
    ),
    route(c.reorderSlides, ({ params, body, actor, audit }) =>
      groups.reorderSlides(params.id, body.revision, body.slideIds, actor, audit),
    ),
    route(c.updateSlide, ({ params, body, actor, audit }) =>
      groups.replaceSlide(params.id, params.slideId, body, actor, audit),
    ),
    route(c.deleteSlide, ({ params, actor, audit }) =>
      groups.deleteSlide(params.id, params.slideId, actor, audit),
    ),

    // Согласование
    route(c.submitGroup, ({ params, body, actor, audit }) =>
      workflow.submit(params.id, body.revision, actor, audit),
    ),
    route(c.approveGroup, ({ params, body, actor, audit }) =>
      workflow.approve(params.id, body.revision, actor, audit),
    ),
    route(c.rejectGroup, ({ params, body, actor, audit }) =>
      workflow.reject(params.id, body.revision, body.comment, actor, audit),
    ),
    route(c.publishGroup, ({ params, actor, audit }) => workflow.publish(params.id, actor, audit)),
    route(c.unpublishGroup, ({ params, body, actor, audit }) =>
      workflow.unpublish(params.id, body.reason ?? null, actor, audit),
    ),
    route(c.getGroupDiff, ({ params }) => workflow.diff(params.id)),
    route(c.getGroupPreview, ({ params }) => workflow.preview(params.id)),
    route(c.listGroupVersions, ({ params }) => workflow.versions(params.id)),

    // Медиа
    route(c.createUploadUrl, ({ body, actor, audit }) => media.createUpload(body, actor, audit)),
    route(c.completeUpload, ({ params, actor, audit, reply }) => {
      reply.code(202);
      return media.complete(params.id, actor, audit);
    }),
    route(c.getMedia, ({ params }) => media.get(params.id)),

    // Справочники
    route(c.listSegments, async () => ({
      items: await deps.prisma.segment.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    })),
    route(c.getCatalogProducts, async ({ query }) => {
      try {
        const items = await withTimeout('catalog', 2000, () =>
          deps.adapters.catalog.getProducts(query.skus),
        );
        return { items };
      } catch {
        adapterErrorsTotal.inc({ adapter: 'catalog' });
        throw new AppError(503, 'catalog_unavailable', 'Каталог временно недоступен');
      }
    }),

    // Статистика и аудит
    route(c.getGroupStats, ({ params, query }) =>
      groupStats(deps, params.id, query.from, query.to),
    ),
    route(c.listAuditLog, ({ query }) => queryAuditLog(deps, query)),

    // Пользователи
    route(c.listUsers, () => users.list()),
    route(c.setUserRoles, ({ params, body, actor, audit }) =>
      users.setRoles(params.id, body.roles, actor, audit),
    ),
    route(c.setUserStatus, ({ params, body, actor, audit }) =>
      users.setStatus(params.id, body.disabled, actor, audit),
    ),

    // Настройки
    route(c.getSettings, () => settings.get()),
    route(c.updateAllowlist, ({ body, actor, audit }) =>
      settings.updateAllowlist(body, actor, audit),
    ),
    route(c.setFeedEnabled, ({ body, actor, audit }) =>
      settings.setFeedEnabled(body.enabled, actor, audit),
    ),
  ];
}
