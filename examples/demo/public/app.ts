/**
 * Demo page: one express-realtime client driving every feature. Bundled by ../server.ts.
 */
import {
  type ChatMessage,
  type ConnectionStatus,
  createRealtimeClient,
  type JoinedRoom,
  type Notification,
  RealtimeClientError,
  type RealtimeEvents,
} from '../../../src/client/index.js';

/** The demo server's own events: call() and on() are typed from this map. */
interface DemoEvents extends RealtimeEvents {
  calls: {
    'order:track': {
      data: number;
      result: { orderId: number; status: string; requestedBy: string };
    };
    'dice:roll': { result: number };
  };
  events: {
    'room:event': [event: { room: string; text: string; at: string }];
  };
}

const USERS = [
  { key: 'ana', id: '1', name: 'Ana', about: 'admin · team red' },
  { key: 'bob', id: '2', name: 'Bob', about: 'team red' },
  { key: 'eve', id: '3', name: 'Eve', about: 'team blue' },
] as const;
const ROOMS = ['lobby', 'team:red', 'team:blue'];

type DemoUser = (typeof USERS)[number];

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`#${id} not found`);
  }

  return element as T;
};
const create = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = '',
  className = '',
): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag);

  element.textContent = text;
  element.className = className;

  return element;
};
/** Runs a task whose failure the page does not need to report. */
const quietly = (task: () => Promise<unknown>): void => {
  void (async () => {
    try {
      await task();
    } catch {
      // Best effort.
    }
  })();
};
const time = (): string => new Date().toLocaleTimeString();
const nameOf = (id: string): string => USERS.find((user) => user.id === id)?.name ?? `#${id}`;
const errorCode = (error: unknown): string =>
  error instanceof RealtimeClientError ? error.code : String(error);
const log = (message: string, kind: '' | 'ok' | 'err' = ''): void => {
  const line = create('div', '', kind);

  line.append(create('span', `${time()}  `, 't'), message);
  $('log').prepend(line);
};
const prependItem = (listId: string, item: HTMLLIElement, max = 50): void => {
  const list = $(listId);

  list.prepend(item);

  while (list.children.length > max) {
    list.lastElementChild?.remove();
  }
};
const toast = (notification: Notification): void => {
  const box = create('div');

  box.style.borderLeftColor = `var(--${notification.level === 'success' ? 'ok' : notification.level === 'warning' ? 'warn' : notification.level === 'error' ? 'err' : 'info'})`;
  box.append(create('strong', notification.title), create('div', notification.message));
  $('toasts').append(box);
  setTimeout(() => {
    box.remove();
  }, 4000);
};

// ---------------------------------------------------------------------------
// Session: fake tokens from /api/token, refreshed when the server warns about expiry.

let me: DemoUser | null = null;
let token: string | null = null;

const post = async (path: string, body: object = {}): Promise<Response> => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  if (token) {
    headers.authorization = token;
  }

  return fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
};
const fetchToken = async (user: DemoUser): Promise<string> => {
  const response = await post('/api/token', { user: user.key });
  const { token: issued } = (await response.json()) as { token: string };

  return issued;
};
const rt = createRealtimeClient<DemoEvents>(window.location.origin, {
  getToken: () => token,
  refreshToken: async () => {
    if (!me) {
      return null;
    }

    token = await fetchToken(me);
    log(`token refreshed for ${me.name}`, 'ok');

    return token;
  },
  onSessionRevoked: (reason) => {
    log(`session revoked: ${reason ?? 'no reason'}`, 'err');
    me = null;
    token = null;
    forgetRooms();
    render();
  },
});
// Opened without a token: the client starts as a guest on the public connection.
const login = async (user: DemoUser): Promise<void> => {
  if (me) {
    logout();
  }

  me = user;
  token = await fetchToken(user);
  render();

  try {
    await rt.login();
    log(`logged in as ${user.name}`, 'ok');
  } catch (error) {
    log(`login failed: ${errorCode(error)}`, 'err');
    me = null;
    token = null;
  }

  render();
};
const logout = (): void => {
  rt.logout();
  log(`logged out${me ? ` (${me.name})` : ''}`);
  me = null;
  token = null;
  forgetRooms();
  render();
};

// ---------------------------------------------------------------------------
// Connection status.

function renderStatus(status: ConnectionStatus): void {
  const pill = $('status');

  pill.className = `pill status-${status}`;

  if (pill.lastElementChild) {
    pill.lastElementChild.textContent = status;
  }

  $('sockets').textContent =
    `public: ${rt.public?.connected ? (rt.public.id ?? '') : 'down'} · private: ${
      rt.private?.connected ? (rt.private.id ?? '') : rt.loggedIn ? 'down' : 'logged out'
    }`;
}

rt.onStatusChange((status) => {
  log(`status → ${status}`, status === 'connected' ? 'ok' : status === 'offline' ? 'err' : '');
  renderStatus(status);
});
rt.onReconnect(({ recovered }) => {
  log(
    recovered
      ? 'reconnected: session recovered, missed events were replayed'
      : 'reconnected: new session, refetch what the UI shows (rooms rejoined automatically)',
    'ok',
  );
});

// ---------------------------------------------------------------------------
// Notifications.

rt.onNotification((notification) => {
  const item = create('li', '', `level-${notification.level}`);

  item.append(
    create('strong', notification.title),
    ` ${notification.message} `,
    create(
      'small',
      `${notification.type}${notification.from ? ` · from ${notification.from.name ?? notification.from.id}` : ''} · ${time()}`,
    ),
  );
  prependItem('notifications', item);
  toast(notification);
  log(`notification [${notification.type}] ${notification.title}`);
});

// ---------------------------------------------------------------------------
// Rooms and custom events.

const joined = new Map<string, JoinedRoom<DemoEvents>>();

/**
 * While logged in, rooms are joined through the private connection, which logout() forgets.
 * leave() also removes the room's listeners, so they do not fire again after the next login.
 */
function forgetRooms(): void {
  for (const handle of joined.values()) {
    quietly(handle.leave);
  }

  joined.clear();
}

const toggleRoom = async (room: string): Promise<void> => {
  const handle = joined.get(room);

  try {
    if (handle) {
      joined.delete(room);
      await handle.leave();
      log(`left ${room}`);
    } else {
      const lobby = await rt.rooms.join(room);

      joined.set(room, lobby);
      lobby.on('room:event', (event) => {
        const item = create('li');

        item.append(create('strong', event.room), ` ${event.text} `, create('small', time()));
        prependItem('room-events', item);
        log(`room:event in ${event.room}: ${event.text}`);
      });
      log(`joined ${room}`, 'ok');
    }
  } catch (error) {
    log(`room ${room}: ${errorCode(error)}`, 'err');
  }

  render();
};

// Library events such as rate:limited are typed without declaring them.
rt.on('rate:limited', ({ event, retryAfterMs }) => {
  log(`rate:limited on ${event}, retry in ${String(retryAfterMs)} ms`, 'err');
});

// ---------------------------------------------------------------------------
// Chat.

const addChat = (message: ChatMessage, mine: boolean): void => {
  const item = create('li', '', mine ? 'mine' : '');

  item.append(
    create('strong', mine ? `to ${nameOf(message.to)}` : nameOf(message.from)),
    ` ${message.text} `,
    create('small', time()),
  );
  prependItem('chat', item);
};

rt.chat.onMessage((message) => {
  // Also delivered to the sender's other tabs.
  addChat(message, message.from === me?.id);
});

const typingFrom = new Map<string, ReturnType<typeof setTimeout>>();
const renderTyping = (): void => {
  const names = [...typingFrom.keys()].map(nameOf);

  $('typing').textContent = names.length ? `${names.join(', ')} typing…` : '';
};

rt.chat.onTyping(({ from, typing }) => {
  clearTimeout(typingFrom.get(from));
  typingFrom.delete(from);

  // Typing events are volatile: expire the indicator in case the "stop" is lost.
  if (typing) {
    typingFrom.set(
      from,
      setTimeout(() => {
        typingFrom.delete(from);
        renderTyping();
      }, 4000),
    );
  }

  renderTyping();
});

let typingTimer: ReturnType<typeof setTimeout> | undefined;

const sendChat = async (): Promise<void> => {
  const input = $<HTMLInputElement>('chat-text');
  const to = $<HTMLSelectElement>('chat-to').value;
  const text = input.value.trim();

  if (!text) {
    return;
  }

  try {
    const message = await rt.chat.send(to, { text });

    addChat(message, true);
    input.value = '';
    rt.chat.typing(to, false);
  } catch (error) {
    log(`chat: ${errorCode(error)}`, 'err');
  }
};

// ---------------------------------------------------------------------------
// Handlers.

let orderId = 1000;

const addCall = (label: string, ok: boolean): void => {
  prependItem('calls', create('li', `${time()}  ${label}`, ok ? 'level-success' : 'level-error'));
};
const track = async (): Promise<void> => {
  orderId += 1;
  const id = orderId;

  try {
    const result = await rt.call('order:track', id);

    addCall(`order #${String(id)}: ${result.status} (asked by ${result.requestedBy})`, true);
  } catch (error) {
    addCall(`order #${String(id)}: ${errorCode(error)}`, false);
  }
};

// ---------------------------------------------------------------------------
// Rendering and wiring.

async function refreshOnline(): Promise<void> {
  const online = (await (await fetch('/api/online')).json()) as Record<string, boolean>;
  const box = $('online');

  box.replaceChildren('Online: ');

  for (const user of USERS) {
    box.append(create('span', `${online[user.key] ? '🟢' : '⚪️'} ${user.name}`));
  }
}

function render(): void {
  $('who').textContent = me ? `${me.name} · ${me.about}` : 'guest';

  for (const button of $('users').querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.user === me?.key);
  }

  for (const button of $('rooms').querySelectorAll('button')) {
    const room = button.dataset.room ?? '';

    button.classList.toggle('active', joined.has(room));
    button.textContent = `${joined.has(room) ? 'Leave' : 'Join'} ${room}`;
  }

  for (const id of ['logout', 'revoke', 'notify-me', 'notify-admins', 'chat-text', 'chat-send']) {
    $<HTMLButtonElement | HTMLInputElement>(id).disabled = !me;
  }

  $<HTMLInputElement>('chat-text').placeholder = me ? 'Message' : 'Log in to chat';
  const chatTo = $<HTMLSelectElement>('chat-to');
  const current = chatTo.value;

  chatTo.replaceChildren(
    ...USERS.filter((user) => user.id !== me?.id).map((user) => {
      const option = create('option', `to ${user.name}`);

      option.value = user.id;

      return option;
    }),
  );

  if ([...chatTo.options].some((option) => option.value === current)) {
    chatTo.value = current;
  }

  renderStatus(rt.status);
}

for (const user of USERS) {
  const button = create('button', user.name);

  button.dataset.user = user.key;
  button.title = user.about;
  button.addEventListener('click', () => void login(user));
  $('users').append(button);
}

for (const room of ROOMS) {
  const button = create('button');
  const option = create('option', room);

  button.dataset.room = room;
  button.addEventListener('click', () => void toggleRoom(room));
  $('rooms').append(button);
  option.value = room;
  $('room-target').append(option);
}

const onClick = (id: string, handler: () => unknown): void => {
  $(id).addEventListener('click', () => {
    void (async () => {
      try {
        await handler();
      } catch (error) {
        log(`${id}: ${errorCode(error)}`, 'err');
      }
    })();
  });
};

onClick('logout', logout);
onClick('revoke', () => post('/api/revoke'));
onClick('drop', () => {
  // Closes the shared engine.io transport: socket.io-client reconnects with recovery.
  (rt.public ?? rt.private)?.io.engine.close();
});
onClick('restart', () => post('/api/restart'));
onClick('announce', () =>
  post('/api/announce', { message: $<HTMLInputElement>('announce-text').value }),
);
onClick('notify-me', () => post('/api/notify/me'));
onClick('notify-admins', async () => {
  const response = await post('/api/notify/admins');

  log(`notified admins (HTTP ${String(response.status)})`);
});
onClick('room-send', () =>
  post(`/api/rooms/${encodeURIComponent($<HTMLSelectElement>('room-target').value)}/event`, {
    text: $<HTMLInputElement>('room-text').value,
  }),
);
onClick('chat-send', sendChat);
onClick('dice', async () => {
  addCall(`dice: ${String(await rt.call('dice:roll', undefined, { scope: 'public' }))}`, true);
});
onClick('track', track);
onClick('spam', () => Promise.all(Array.from({ length: 6 }, track)));

$<HTMLInputElement>('chat-text').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    void sendChat();

    return;
  }

  const to = $<HTMLSelectElement>('chat-to').value;

  rt.chat.typing(to, true);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    rt.chat.typing(to, false);
  }, 1500);
});

render();
log('guest on the public connection. Pick a user to log in.');
setInterval(() => {
  quietly(refreshOnline);
}, 2000);
quietly(refreshOnline);
