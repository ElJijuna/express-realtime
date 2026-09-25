import { randomUUID } from 'node:crypto';
import { withAck } from './ack.js';
import type { RealtimeContext } from './context.js';
import type { ChatMessage } from './contract.js';
import { RealtimeError, RealtimeValidationError } from './errors.js';
import { dmRoom, EVENTS, userRoom } from './events.js';
import type { RealtimeSocket } from './types.js';

/** 1:1 chat. Messages go to every socket of both users; the library keeps no history. */
export interface ChatService {
  /**
   * Sends a message on behalf of `from`, e.g. from a REST endpoint or a bot.
   * `onChatMessage` runs first; `canChat` does not, since server-side sends are trusted.
   */
  send<T = Record<string, unknown>>(
    from: string | number,
    to: string | number,
    input: { text: string; data?: T },
  ): Promise<ChatMessage<T>>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const createChat = <User>(
  ctx: RealtimeContext<User>,
): ChatService & { attach(socket: RealtimeSocket<User>): void } => {
  const maxLength = ctx.options.chatMaxLength ?? 4000;
  const parseRecipient = (value: unknown): string => {
    if ((typeof value !== 'string' && typeof value !== 'number') || String(value) === '') {
      throw new RealtimeError('invalid_recipient');
    }

    return String(value);
  };
  const buildMessage = <T>(
    from: string,
    to: string,
    text: unknown,
    data: T | undefined,
  ): ChatMessage<T> => {
    if (typeof text !== 'string' || text.trim() === '') {
      throw new RealtimeValidationError('chat text is required');
    }

    if (text.length > maxLength) {
      throw new RealtimeValidationError(`chat text exceeds ${String(maxLength)} chars`);
    }

    if (data !== undefined && !isPlainObject(data)) {
      throw new RealtimeValidationError('chat data must be an object');
    }

    const message: ChatMessage<T> = {
      id: randomUUID(),
      conversationId: dmRoom(from, to),
      from,
      to,
      text,
      date: new Date().toISOString(),
    };

    if (data !== undefined) {
      message.data = data;
    }

    return message;
  };
  const persist = async (
    message: ChatMessage,
    user: User | null,
    socket: RealtimeSocket<User> | null,
  ): Promise<void> => {
    if (!ctx.options.onChatMessage) {
      return;
    }

    try {
      await ctx.options.onChatMessage(message, { user, socket });
    } catch (error) {
      if (error instanceof RealtimeError) {
        throw error;
      }

      ctx.obs.reportError(error, {
        scope: 'chat',
        event: EVENTS.chatSend,
        socketId: socket?.id,
        userId: message.from,
      });

      throw new RealtimeError('chat_rejected');
    }
  };
  const authorize = async (socket: RealtimeSocket<User>, to: string): Promise<User> => {
    const { user, userId, scope } = socket.data;

    if (scope !== 'private' || user === null || userId === null) {
      throw new RealtimeError('unauthorized');
    }

    if (to === userId) {
      throw new RealtimeError('invalid_recipient');
    }

    if (ctx.options.canChat && !(await ctx.options.canChat(user, to))) {
      throw new RealtimeError('forbidden');
    }

    return user;
  };

  return {
    async send(from, to, input) {
      const message = buildMessage(String(from), parseRecipient(to), input.text, input.data);

      await persist(message as ChatMessage, null, null);
      ctx.privateNsp
        .to([userRoom(message.from), userRoom(message.to)])
        .emit(EVENTS.chatMessage, message);

      return message;
    },

    attach(socket) {
      if (ctx.options.chat === false) {
        return;
      }

      socket.on(
        EVENTS.chatSend,
        withAck(ctx, socket, EVENTS.chatSend, async (raw) => {
          if (!isPlainObject(raw)) {
            throw new RealtimeValidationError('chat:send expects { to, text, data? }');
          }

          const to = parseRecipient(raw.to);
          const user = await authorize(socket, to);
          const message = buildMessage(
            socket.data.userId ?? '',
            to,
            raw.text,
            raw.data as Record<string, unknown> | undefined,
          );

          await persist(message, user, socket);
          // The sending socket gets the message through the ack; the sender's other tabs get it here.
          socket
            .to([userRoom(message.from), userRoom(message.to)])
            .emit(EVENTS.chatMessage, message);

          return message;
        }),
      );

      socket.on(EVENTS.chatTyping, async (raw: unknown) => {
        try {
          if (!isPlainObject(raw)) {
            return;
          }

          const to = parseRecipient(raw.to);

          await authorize(socket, to);
          // Volatile: dropped for recipients that cannot take it right now instead of queued.
          socket.to(userRoom(to)).volatile.emit(EVENTS.chatTyping, {
            from: socket.data.userId,
            typing: raw.typing === true,
          });
        } catch (error) {
          if (!(error instanceof RealtimeError)) {
            ctx.obs.reportError(error, {
              scope: 'chat',
              event: EVENTS.chatTyping,
              socketId: socket.id,
              userId: socket.data.userId,
            });
          }
        }
      });
    },
  };
};
