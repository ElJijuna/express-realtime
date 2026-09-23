import type { RealtimeContext } from './context.js';
import type { NotificationInput } from './contract.js';
import { SYNC_EVENT } from './events.js';
import type { AnyNamespace } from './types.js';

/** Hot configuration change propagated to the other pods. */
export type SyncMessage =
  | { kind: 'welcome'; scope: 'public' | 'private'; value: NotificationInput | null }
  | {
      kind: 'room';
      name: string;
      patch: { welcome?: NotificationInput | null; announce?: NotificationInput | null };
    };

export interface Sync {
  publish(message: SyncMessage): void;
  subscribe(listener: (message: SyncMessage) => void): void;
}

/** In-memory adapters log a warning on `serverSideEmit` and have no other pods to reach. */
const LOCAL_ADAPTERS = new Set(['Adapter', 'SessionAwareAdapter']);
const isClusterAdapter = (nsp: AnyNamespace): boolean =>
  !LOCAL_ADAPTERS.has((nsp.adapter as object).constructor.name);

/** Propagates hot configuration changes with `serverSideEmit` on the private namespace. */
export const createSync = <User>(ctx: RealtimeContext<User>): Sync => {
  const listeners: ((message: SyncMessage) => void)[] = [];
  const enabled = (): boolean => ctx.options.clusterSync ?? isClusterAdapter(ctx.privateNsp);

  ctx.privateNsp.on(SYNC_EVENT, (message: SyncMessage) => {
    for (const listener of listeners) {
      listener(message);
    }
  });

  return {
    publish(message) {
      if (!enabled()) {
        return;
      }

      try {
        ctx.privateNsp.serverSideEmit(SYNC_EVENT, message);
      } catch (error) {
        ctx.obs.reportError(error, { scope: 'sync' });
      }
    },
    subscribe(listener) {
      listeners.push(listener);
    },
  };
};
