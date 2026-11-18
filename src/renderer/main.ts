/** The connector window: plain DOM, no framework. All text is Turkish. */
import type { ConnectorBridge, UiAccount, UiState } from '../shared/ipc';

declare global {
  interface Window {
    connector: ConnectorBridge;
  }
}

const api = window.connector;

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}
const input = (id: string) => $(id) as HTMLInputElement;
const button = (id: string) => $(id) as HTMLButtonElement;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string } = {},
  ...children: Node[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  for (const c of children) node.appendChild(c);
  return node;
}

function show(node: HTMLElement, visible: boolean): void {
  node.hidden = !visible;
}

function setMessage(id: string, text: string | null): void {
  const node = $(id);
  node.textContent = text ?? '';
  show(node, !!text);
}

const timeFmt = new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const platformName = (p: string | null) => (p === 'macos' ? 'macOS' : p === 'windows' ? 'Windows' : 'desteklenmeyen sistem');

let current: UiState | null = null;
let pairNameTouched = false;

function statusBadge(a: UiAccount): HTMLElement {
  if (a.status === 'active') return el('span', { className: 'badge badge--ok', text: 'Etkin' });
  if (a.status === 'tokenRejected') return el('span', { className: 'badge badge--bad', text: 'Token reddedildi' });
  return el('span', { className: 'badge badge--warn', text: 'Panel kabul etmedi' });
}

function avatar(a: UiAccount): HTMLElement {
  if (a.avatarUrl && a.avatarUrl.startsWith('https://cdn.discordapp.com/')) {
    const img = el('img', { className: 'avatar' });
    img.src = a.avatarUrl;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    return img;
  }
  return el('span', { className: 'avatar', text: (a.displayName || '?').slice(0, 1).toUpperCase() });
}

function renderAccount(a: UiAccount): HTMLElement {
  const remove = el('button', { className: 'btn btn--ghost btn--small', text: 'Kaldır' });
  remove.type = 'button';
  remove.addEventListener('click', async () => {
    if (!confirm(`${a.displayName} hesabı ve tokeni bu bilgisayardan silinsin mi?`)) return;
    remove.disabled = true;
    const r = await api.removeAccount(a.discordUserId);
    if (!r.ok) {
      remove.disabled = false;
      alert(r.message);
    } else if (r.message) {
      alert(r.message);
    }
  });

  const meta = el(
    'div',
    { className: 'account__meta' },
    el('p', { className: 'account__name', text: a.displayName }),
    statusBadge(a),
  );
  const head = el('div', { className: 'account__head' }, avatar(a), meta, remove);
  const item = el('li', { className: 'account' }, head);

  if (a.statusText && a.status !== 'active') {
    item.appendChild(el('p', { className: 'muted small', text: a.statusText }));
  }
  if (a.lastResults.length) {
    const list = el('ul', { className: 'results' });
    for (const r of a.lastResults) {
      const t = el('time', { text: timeFmt.format(new Date(r.at)) });
      t.setAttribute('datetime', r.at);
      const outcome = el('span', {
        className: `result__outcome--${r.outcome}`,
        text: r.outcome === 'sent' ? 'Gönderildi' : 'Gönderilemedi',
      });
      const parts: Node[] = [t, outcome];
      if (r.reason) parts.push(el('span', { text: r.reason }));
      list.appendChild(el('li', { className: 'result' }, ...parts));
    }
    item.appendChild(list);
  } else {
    item.appendChild(el('p', { className: 'muted small', text: 'Henüz gönderim yok.' }));
  }
  return item;
}

function render(state: UiState): void {
  current = state;
  const paired = state.connection !== 'unpaired';

  const pill = $('status-pill');
  pill.textContent = paired && state.paused && state.connection === 'online' ? 'Duraklatıldı' : state.statusLabel;
  pill.className = 'pill';
  if (paired && state.paused) pill.classList.add('pill--paused');
  else if (state.connection === 'online') pill.classList.add('pill--online');
  else if (state.connection === 'offline') pill.classList.add('pill--offline');

  $('device-line').textContent = state.device
    ? `${state.device.deviceName} · ${platformName(state.device.platform)}`
    : 'Eşleştirilmemiş cihaz';

  setMessage('notice', state.notice);
  show($('encryption-warning'), !state.encryptionAvailable);

  show($('view-pair'), !paired);
  show($('view-main'), paired);

  if (!paired) {
    if (!pairNameTouched && !input('pair-name').value) input('pair-name').value = state.defaultDeviceName;
    $('pair-platform').textContent = `Platform: ${platformName(state.platform)}`;
    button('pair-submit').disabled = !state.encryptionAvailable || !state.platform;
  } else {
    button('pause-toggle').textContent = state.paused ? 'Gönderimi sürdür' : 'Gönderimi duraklat';
    $('pause-line').textContent = state.paused
      ? 'Gönderim duraklatıldı. Bu sırada gelen gönderimler "Gönderim bağlayıcıda duraklatıldı" nedeniyle başarısız sayılır.'
      : state.connection === 'offline'
        ? 'Sunucuya ulaşılamıyor; bağlantı geri geldiğinde otomatik olarak devam edilir. Çevrimdışıyken zamanı gelen mesajlar gönderilmez.'
        : 'Zamanı gelen mesajlar bu bilgisayardan gönderilir. Uygulamayı kapatsanız da sistem tepsisinde çalışmaya devam eder.';

    const list = $('accounts');
    list.replaceChildren(...state.accounts.map(renderAccount));
    show($('accounts-empty'), state.accounts.length === 0);
    button('add-submit').disabled = !state.encryptionAvailable;
  }

  $('footer').textContent = `Sürüm ${state.version}${state.environment !== 'production' ? ` · ${state.environment}` : ''}`;
}

async function withBusy(btn: HTMLButtonElement, fn: () => Promise<void>): Promise<void> {
  btn.disabled = true;
  try {
    await fn();
  } finally {
    btn.disabled = false;
    if (current) render(current);
  }
}

input('pair-name').addEventListener('input', () => {
  pairNameTouched = true;
});

$('pair-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = input('pair-code').value.trim();
  const name = input('pair-name').value.trim();
  setMessage('pair-error', null);
  if (!code) return setMessage('pair-error', 'Eşleştirme kodunu girin.');
  if (!name) return setMessage('pair-error', 'Cihaz adını girin.');
  void withBusy(button('pair-submit'), async () => {
    const r = await api.pair(code, name);
    if (!r.ok) setMessage('pair-error', r.message);
    else input('pair-code').value = '';
  });
});

$('add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  setMessage('add-error', null);
  setMessage('add-ok', null);
  const tokenInput = input('add-token');
  if (!tokenInput.value.trim()) return setMessage('add-error', 'Tokeni yapıştırın.');
  if (!input('add-tos').checked) return setMessage('add-error', 'Devam etmek için uyarıyı onaylayın.');
  void withBusy(button('add-submit'), async () => {
    const token = tokenInput.value;
    tokenInput.value = '';
    const r = await api.addAccount(token);
    if (r.ok) {
      input('add-tos').checked = false;
      setMessage('add-ok', r.message ?? 'Hesap eklendi.');
    } else {
      setMessage('add-error', r.message);
    }
  });
});

button('pause-toggle').addEventListener('click', () => {
  if (!current) return;
  void withBusy(button('pause-toggle'), async () => {
    await api.setPaused(!current!.paused);
  });
});

button('unpair').addEventListener('click', () => {
  const ok = confirm(
    'Eşleştirme kaldırılsın mı? Bu bilgisayardaki cihaz kimliği ve tüm Discord tokenleri silinir. Cihazı web panelinden de kaldırın.',
  );
  if (!ok) return;
  void withBusy(button('unpair'), async () => {
    const r = await api.unpair();
    if (!r.ok) alert(r.message);
  });
});

api.onState(render);
void api.getState().then(render);
