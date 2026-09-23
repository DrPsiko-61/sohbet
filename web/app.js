/* Sohbet istemcisi — dusuk bant genisligi icin optimize edilmis */

const MAX_DOM_MESSAGES = 220;
const PAGE_SIZE = 50;
const GROUP_WINDOW_MS = 5 * 60 * 1000;

const state = {
  me: null,
  inviteCode: '',
  rtc: { enabled: false, url: '' },
  servers: [],
  users: new Map(),
  serverId: null,
  channel: null,
  messages: [],
  oldestId: null,
  hasMore: false,
  online: new Set(),
  voice: {},
  typing: new Map(),
  uploading: [],
  socket: null,
  reconnectDelay: 1000,
  panelTab: 'users',
  panelData: null
};

const voice = {
  room: null,
  channelId: null,
  mic: false,
  cam: false,
  screen: false,
  mod: null,
  // Kisi basina ses seviyesi (0..2) ve uygulananlar kumesi
  volumes: new Map(),
  // Kisi basina ekran paylasimi sesi seviyesi (0..2, izleyen icin)
  screenVolumes: new Map(),
  applied: new Set(),
  // Kamera yonu ve cihaz secimleri
  facing: 'user',
  cameraCount: 0,
  micDevice: '',
  camDevice: '',
  // Capture card secimleri (aygit, ses kaynagi, kalite, kodek)
  cardDevice: localStorage.getItem('sohbet.kart') || '',
  cardAudio: localStorage.getItem('sohbet.kart.ses') || '',
  cardQuality: localStorage.getItem('sohbet.kart.kalite') || '',
  cardCodec: localStorage.getItem('sohbet.kart.kodek') || '',
  // Kamera kalitesi, flas durumu ve arka plan sesi durumlari
  cameraQuality: '',
  torch: false,
  torchAvailable: false,
  wakeLock: false,
  needsTapForAudio: false,
  // Bas konuş (push-to-talk): yalnızca bilgisayarda, seçili tuş basılıyken mikrofon açılır.
  ptt: false,
  pttKey: localStorage.getItem('sohbet.ptt.tus') || 'Space',
  // Konuşma modu: 'ptt' (bas konuş) veya 'vad' (ses algılama). VAD arka planda da çalışır.
  konusmaMod: localStorage.getItem('sohbet.konusma.mod') === 'vad' ? 'vad' : 'ptt',
  // Gürültü engelleme (tarayıcının yerleşik RNNoise'ı)
  gurultu: localStorage.getItem('sohbet.gurultu') !== '0',
  vad: false,
  vadEsik: (() => {
    const v = Number(localStorage.getItem('sohbet.vad.esik') ?? NaN);
    return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 60;
  })(),
  // Sağırlaştırma: mikrofon kapalı + gelen sesler susdurulur (Discord'daki gibi).
  sagir: false
};

// Ortak çizim tahtası (oyun) durumu. Renkler sunucudan atanır; noktalar 0..1.
const DRAW_RENKLER = ['#ef4444', '#f97316', '#facc15', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899', '#a855f7', '#0ea5e9'];
const ciz = {
  acik: false,
  kanal: null,
  renk: '',
  firca: 4,
  katilimcilar: [],
  strokes: [],
  ciziyor: false,
  aktif: null,
  son: null,
  ctx: null
};

const $ = (id) => document.getElementById(id);
// Bas konuş klavye gerektirir: yalnızca fareli/klavyeli cihazlarda sunulur.
const masaustu = typeof window !== 'undefined' &&
  window.matchMedia?.('(hover: hover) and (pointer: fine)')?.matches === true;

/// Bas konuş için seçilebilen tuşlar (kod -> okunur ad).
const PTT_TUSLAR = {
  Space: 'Boşluk',
  ControlLeft: 'Sol Ctrl',
  ShiftLeft: 'Sol Shift',
  AltLeft: 'Sol Alt',
  KeyV: 'V',
  KeyB: 'B',
  KeyC: 'C',
  KeyN: 'N'
};
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

function avatarNode(user, size = '') {
  const node = el('span', `avatar ${size}`.trim());
  const name = user?.displayName || user?.name || '?';
  const url = user?.avatarUrl || user?.avatar_url;
  if (url) {
    node.style.backgroundImage = `url("${url}")`;
    node.textContent = '';
  } else {
    node.style.backgroundImage = '';
    node.style.background = user?.avatarColor || user?.avatar_color || '#5865f2';
    node.textContent = initials(name);
  }
  return node;
}

function roleTagNode(role, isBot) {
  const r = (isBot || role === 'bot') ? 'bot' : role;
  if (!r || r === 'member' || r === 'guest') return null;
  const tag = el('span', `role-tag role-${r}`);
  const labels = {
    owner: 'KURUCU',
    admin: 'YÖNETİCİ',
    mod: 'MOD',
    bot: 'BOT'
  };
  tag.textContent = labels[r] || r.toUpperCase();
  return tag;
}

/// Zengin metin render'i: **kalın**, *italik*, `kod`, ```blok``` ve bağlantılar.
/// Metin önce HTML-kaçışlanır, sonra güvenli etiketlerle işaretlenir.
function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderRichText(content) {
  const div = document.createElement('div');
  div.className = 'rich';
  let text = escapeHtml(content);
  // Kod blokları (```...```) önce korunur.
  const blocks = [];
  text = text.replace(/```([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre class="code-block">${code}</pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  // Satır içi kod (`...`)
  text = text.replace(/`([^`\n]+)`/g, '<code class="code-inline">$1</code>');
  // Bağlantılar (http/https)
  text = text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  // Kalın **...**
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // İtalik *...*
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // @bahsetme vurgusu
  text = text.replace(/@([\w.\-]+)/g, (m, uname) => {
    const u = Array.from(state.users.values()).find((x) => x.username?.toLowerCase() === uname.toLowerCase());
    return u ? `<span class="mention">@${escapeHtml(u.displayName)}</span>` : m;
  });
  // Satır sonları
  text = text.replace(/\n/g, '<br>');
  // Korunan blokları geri koy
  text = text.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  div.innerHTML = text;
  return div;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

function fmtDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(Date.now() - 86400000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Bugün';
  if (same(d, yest)) return 'Dün';
  return d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function toast(message, ms = 2600) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { node.hidden = true; }, ms);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin'
  });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data?.error || `http_${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const ERROR_TR = {
  unauthorized: 'Oturum süresi doldu, tekrar giriş yap',
  invalid_credentials: 'Kullanıcı adı veya parola hatalı',
  username_taken: 'Bu kullanıcı adı alınmış',
  invalid_username: 'Kullanıcı adı 3-20 karakter olmalı (harf, rakam, . _ -)',
  weak_password: 'Parola en az 8 karakter olmalı',
  invite_required: 'Davet kodu gerekli',
  forbidden: 'Bunun için yetkin yok',
  slow_down: 'Çok hızlı yazıyorsun, biraz yavaşla',
  empty_message: 'Boş mesaj gönderilemez',
  file_too_large: 'Dosya çok büyük (en fazla 8 MB)',
  too_many_attempts: 'Çok fazla deneme yaptın, biraz bekle',
  not_text_channel: 'Bu kanala metin yazılamaz',
  not_voice_channel: 'Bu kanalda sesli görüşme yok',
  rtc_disabled: 'Sesli görüşme bu sunucuda yapılandırılmamış',
  cannot_disable_self: 'Kendini devre dışı bırakamazsın'
};
const tr = (code, fallback) => ERROR_TR[code] || fallback || 'Bir hata oluştu';

/* ==================== OTURUM ==================== */
let registerMode = false;

function setAuthMode(next) {
  registerMode = next;
  $('auth-title').textContent = next ? 'Kayıt ol' : 'Giriş yap';
  $('btn-auth').textContent = next ? 'Kayıt ol' : 'Giriş yap';
  $('btn-toggle-auth').textContent = next ? 'Zaten hesabın var mı? Giriş yap' : 'Hesabın yok mu? Kayıt ol';
  $('field-display').hidden = !next;
  $('field-invite').hidden = !next;
  $('in-password').autocomplete = next ? 'new-password' : 'current-password';
  $('auth-hint').textContent = next
    ? 'İlk hesap yönetici olur. Sonraki hesaplar için davet kodu gerekir.'
    : 'Kullanıcı adın ve parolan ile gir.';
  $('auth-error').hidden = true;
}

$('btn-toggle-auth').addEventListener('click', () => setAuthMode(!registerMode));

$('form-auth').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('btn-auth');
  const errBox = $('auth-error');
  errBox.hidden = true;
  button.disabled = true;
  button.textContent = 'Bekle…';
  try {
    const payload = {
      username: $('in-username').value.trim(),
      password: $('in-password').value
    };
    if (registerMode) {
      payload.displayName = $('in-display').value.trim() || payload.username;
      payload.inviteCode = $('in-invite').value.trim();
    }
    await api(registerMode ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: payload });
    $('in-password').value = '';
    // Giriş başarılı: minik uyarı sesi çal.
    minikSesCal();
    await startApp();
  } catch (error) {
    errBox.textContent = tr(error.message);
    errBox.hidden = false;
  } finally {
    button.disabled = false;
    setAuthMode(registerMode);
  }
});

$('btn-logout').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  location.reload();
});

/* ==================== UYGULAMA BAŞLAT ==================== */
async function startApp() {
  let boot;
  try {
    boot = await api('/api/bootstrap');
  } catch (error) {
    if (error.status === 401) {
      $('screen-auth').hidden = false;
      $('screen-main').hidden = true;
      setAuthMode(false);
      return;
    }
    throw error;
  }
  state.me = boot.user;
  state.inviteCode = boot.inviteCode || '';
  state.rtc = boot.rtc || { enabled: false, url: '' };
  state.servers = boot.servers || [];
  state.users = new Map((boot.users || []).map((u) => [u.id, u]));
  state.online = new Set(boot.online || []);
  state.voice = boot.voice || {};
  state.serverId = state.servers[0]?.id ?? null;

  $('screen-auth').hidden = true;
  $('screen-main').hidden = false;

  renderMe();
  renderServers();
  renderChannels();
  renderMembersSide();

  const first = currentChannels().find((c) => c.type === 'text');
  if (first) await openChannel(first.id);
  renderVoice();
  // Masaüstünde sağ sohbet paneli açık başlar; telefonda düğmeyle açılır.
  cside.acik = window.matchMedia('(min-width:820px)').matches;
  chatSideCiz();

  connectSocket();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    // Statik dosyalar onbellekten (cache-first) sunulur. Yeni surum devreye
    // girdiginde sayfa bir kez yenilenir; boylece guncelleme kendiliginden gelir
    // ve kullanicinin elle onbellek temizlemesi gerekmez.
    if (!window.__swReload) {
      window.__swReload = true;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        // Oturum basina yalnizca BIR kez yenilenir; boylece olasi bir dongu
        // sayfanin surekli yenilenmesine yol acamaz.
        if (sessionStorage.getItem('sohbet-guncellendi') === '1') return;
        sessionStorage.setItem('sohbet-guncellendi', '1');
        location.reload();
      });
    }
  }
}

function renderMe() {
  const me = state.me;
  $('me-name').textContent = me.displayName;
  $('me-avatar').replaceWith(Object.assign(avatarNode(me), { id: 'me-avatar' }));
  $('me-status').textContent = me.status || ({ owner: 'kurucu', admin: 'yönetici', mod: 'moderatör', guest: 'misafir' }[me.role] || 'çevrimiçi');
  $('btn-panel').hidden = !['owner', 'admin', 'mod'].includes(me.role);
}

function currentServer() {
  return state.servers.find((s) => s.id === state.serverId) || null;
}
function currentChannels() {
  return currentServer()?.channels || [];
}

function renderServers() {
  const select = $('sel-server');
  select.innerHTML = '';
  for (const server of state.servers) {
    const option = el('option', null, server.name);
    option.value = String(server.id);
    select.append(option);
  }
  select.value = String(state.serverId ?? '');
  select.onchange = async () => {
    state.serverId = Number(select.value);
    renderChannels();
    const first = currentChannels().find((c) => c.type === 'text');
    if (first) await openChannel(first.id);
    renderVoice();
  };
}

const ICON_HASH = '<svg class="cico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 4 7 20M17 4l-2 16M4 9h16M3 15h16"/></svg>';
const ICON_SPK = '<svg class="cico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>';


function renderChannels() {
  const list = $('chan-list');
  list.innerHTML = '';
  // İzleme odası kaldırıldı: DB'de kalmış 'watch' kanalları gösterilmez.
  const channels = currentChannels().filter((c) => c.type !== 'watch');
  const groups = [
    { type: 'text', label: 'Metin kanalları' },
    { type: 'voice', label: 'Sesli kanallar' }
  ];
  for (const group of groups) {
    const items = channels.filter((c) => c.type === group.type);
    if (!items.length) continue;
    const wrap = el('div', 'chan-group');
    wrap.append(el('h3', null, group.label));
    for (const channel of items) {
      const button = el('button', 'chan');
      button.type = 'button';
      button.innerHTML = group.type === 'text' ? ICON_HASH : ICON_SPK;
      button.append(el('span', 'cname', channel.name));
      if (channel.isPrivate) {
        const lock = el('span', 'lock', '🔒');
        lock.title = 'Özel kanal';
        button.append(lock);
      }
      if (channel.type === 'voice') {
        const users = state.voice[channel.id] || [];
        if (users.length) {
          const badge = el('span', 'badge', String(users.length));
          button.append(badge);
        }
      }
      if (state.channel?.id === channel.id) button.classList.add('active');
      button.addEventListener('click', async () => {
        closeSidebar();
        if (channel.type === 'text') {
          await openChannel(channel.id);
          return;
        }
        await openChannel(channel.id);
        await joinVoice(channel);
      });
      wrap.append(button);
      if (channel.type === 'voice') {
        const users = state.voice[channel.id] || [];
        if (users.length) {
          const vUsersWrap = el('div', 'chan-voice-users');
          for (const u of users) {
            const userObj = state.users.get(u.userId) || { displayName: 'Bilinmeyen', avatarColor: '#5865f2' };
            const uRow = el('div', 'chan-vuser');
            uRow.append(avatarNode(userObj, 'xs'));
            uRow.append(el('span', 'chan-vname', userObj.displayName));
            const tag = roleTagNode(userObj.role, userObj.isBot || userObj.username === 'muzik-botu');
            if (tag) uRow.append(tag);
            uRow.addEventListener('click', (e) => {
              e.stopPropagation();
              if (voice.channelId && Number(voice.channelId) === Number(channel.id) && u.userId !== state.me.id) {
                openAudioSheet(u.userId);
              }
            });
            vUsersWrap.append(uRow);
          }
          wrap.append(vUsersWrap);
        }
      }
    }
    list.append(wrap);
  }
}

/* ==================== KANAL & MESAJLAR ==================== */
async function openChannel(channelId) {
  const channel = currentChannels().find((c) => c.id === channelId);
  if (!channel) return;
  state.channel = channel;
  state.messages = [];
  state.oldestId = null;
  state.hasMore = false;
  $('head-chan').textContent = `# ${channel.name}`;
  $('head-topic').textContent = channel.topic || '';
  const list = $('msg-list');
  list.innerHTML = '';
  list.classList.remove('empty');
  renderChannels();
  renderMembersSide();
  await loadMessages();
  chatSideKanalDoldur();
}

async function loadMessages(before = null) {
  const channel = state.channel;
  if (!channel) return;
  const query = `/api/channels/${channel.id}/messages?limit=${PAGE_SIZE}` + (before ? `&before=${before}` : '');
  const data = await api(query);
  if (state.channel?.id !== channel.id) return;
  const list = $('msg-list');

  if (!before) {
    state.messages = data.messages;
    list.innerHTML = '';
    if (!data.messages.length) list.classList.add('empty');
    renderMessageBatch(data.messages, list, false);
  } else {
    const y = list.scrollHeight - list.scrollTop;
    state.messages = [...data.messages, ...state.messages];
    const fragment = document.createDocumentFragment();
    renderMessageBatch(data.messages, fragment, true);
    $('load-more')?.remove();
    list.prepend(fragment);
    list.scrollTop = list.scrollHeight - y;
  }
  state.oldestId = state.messages[0]?.id ?? null;
  state.hasMore = data.messages.length === PAGE_SIZE;

  const existing = $('load-more');
  if (existing) existing.remove();
  if (state.hasMore) {
    const more = el('button', 'load-more', 'Eski mesajları yükle');
    more.id = 'load-more';
    more.type = 'button';
    more.addEventListener('click', async () => {
      more.textContent = 'Yükleniyor…';
      more.disabled = true;
      try { await loadMessages(state.oldestId); } catch { more.textContent = 'Tekrar dene'; more.disabled = false; }
    });
    list.prepend(more);
  }
  list.scrollTop = list.scrollHeight;
  trimDom();
}

function messageNode(message, grouped) {
  const node = el('div', 'msg' + (grouped ? ' grouped' : ''));
  node.dataset.mid = String(message.id);
  const author = state.users.get(message.userId);
  if (author) node.append(avatarNode(author));

  const body = el('div', 'msg-body');
  if (!grouped) {
    const head = el('div', 'msg-head');
    const name = el('strong', null, author?.displayName || 'Bilinmeyen');
    head.append(name);
    const tag = roleTagNode(author?.role, author?.isBot || author?.username === 'muzik-botu');
    if (tag) head.append(tag);
    const time = el('time', null, fmtTime(message.createdAt));
    time.dateTime = new Date(message.createdAt).toISOString();
    head.append(time);
    const actions = el('div', 'msg-actions');
    actions.style.marginLeft = 'auto';
    if (message.userId === state.me.id) {
      const edit = el('button', null, '✏️');
      edit.type = 'button';
      edit.title = 'Düzenle';
      edit.addEventListener('click', () => startEditMessage(message.id));
      actions.append(edit);
    }
    if (message.userId === state.me.id || ['owner', 'admin', 'mod'].includes(state.me.role)) {
      const del = el('button', null, '🗑');
      del.type = 'button';
      del.title = 'Sil';
      del.addEventListener('click', () => deleteMessage(message.id));
      actions.append(del);
    }
    head.append(actions);
    body.append(head);
  }
  if (message.replyTo) {
    const quoted = state.messages.find((m) => m.id === message.replyTo);
    const quote = el('div', 'msg-quote', quoted
      ? `${state.users.get(quoted.userId)?.displayName || '?'}: ${quoted.content.slice(0, 70)}`
      : 'Yanıtlanan mesaj');
    body.append(quote);
  }
  if (message.content) {
    const text = el('div', 'msg-text' + (message.editedAt ? ' edited' : ''));
    text.append(renderRichText(message.content));
    if (message.editedAt) text.append(el('span', 'edited-mark', ' (düzenlendi)'));
    body.append(text);
  }
  if (message.attachments?.length) {
    const wrap = el('div', 'msg-att');
    for (const file of message.attachments) {
      if (file.mime?.startsWith('audio/')) {
        const audio = el('audio');
        audio.controls = true;
        audio.preload = 'metadata';
        audio.src = file.url;
        wrap.append(audio);
      } else if (file.mime?.startsWith('image/')) {
        const img = el('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = file.url;
        img.alt = file.filename;
        img.addEventListener('click', () => window.open(file.url, '_blank', 'noopener'));
        wrap.append(img);
      } else {
        const link = el('a', 'file');
        link.href = file.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.append(el('span', null, `📄 ${file.filename}`));
        link.append(el('span', 'muted', `${Math.round(file.size / 1024)} KB`));
        wrap.append(link);
      }
    }
    body.append(wrap);
  }
  if (message.userId === state.me.id) node.classList.add('own');
  node.append(body);
  return node;
}

function renderMessageBatch(messages, container, isPrepend) {
  let last = isPrepend ? null : state.messages.length > messages.length ? state.messages[messages.length - messages.length - 1] : null;
  let lastDay = null;
  for (const message of messages) {
    const day = fmtDay(message.createdAt);
    if (day !== lastDay) {
      container.append(el('div', 'day-sep', day));
      lastDay = day;
      last = null;
    }
    const grouped = Boolean(last) && last.userId === message.userId &&
      message.createdAt - last.createdAt < GROUP_WINDOW_MS && !message.replyTo;
    container.append(messageNode(message, grouped));
    last = message;
  }
}

function trimDom() {
  const list = $('msg-list');
  const nodes = list.querySelectorAll('.msg');
  if (nodes.length <= MAX_DOM_MESSAGES) return;
  const remove = nodes.length - MAX_DOM_MESSAGES;
  for (let i = 0; i < remove; i += 1) {
    nodes[i].remove();
    state.messages.shift();
  }
}

function appendMessage(message) {
  state.messages.push(message);
  const list = $('msg-list');
  list.classList.remove('empty');
  const previous = state.messages[state.messages.length - 2];
  const day = fmtDay(message.createdAt);
  const lastSep = [...list.querySelectorAll('.day-sep')].pop();
  if (!lastSep || lastSep.textContent !== day) {
    list.append(el('div', 'day-sep', day));
  }
  const grouped = Boolean(previous) && previous.userId === message.userId &&
    message.createdAt - previous.createdAt < GROUP_WINDOW_MS && !message.replyTo &&
    (!lastSep || lastSep.textContent === day);
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  list.append(messageNode(message, grouped));
  trimDom();
  if (nearBottom || message.userId === state.me.id) list.scrollTop = list.scrollHeight;
}

async function deleteMessage(id) {
  if (!confirm('Bu mesajı silmek istediğine emin misin?')) return;
  try {
    await api(`/api/messages/${id}`, { method: 'DELETE' });
  } catch (error) {
    toast(tr(error.message));
  }
}

let editingMessageId = null;

function startEditMessage(id) {
  const message = state.messages.find((m) => m.id === id);
  if (!message) return;
  editingMessageId = id;
  const node = $('msg-list').querySelector(`[data-mid="${id}"]`);
  if (!node) return;
  const textEl = node.querySelector('.msg-text');
  if (!textEl) return;
  textEl.innerHTML = '';
  const editor = el('div', 'edit-box');
  const input = el('textarea', 'edit-input', message.content);
  input.maxLength = 4000;
  input.rows = 2;
  const row = el('div', 'edit-actions');
  const save = el('button', 'btn-sm', 'Kaydet');
  save.type = 'button';
  save.addEventListener('click', () => saveEditMessage(id, input.value));
  const cancel = el('button', 'btn-sm', 'Vazgeç');
  cancel.type = 'button';
  cancel.addEventListener('click', () => cancelEditMessage(id));
  row.append(save, cancel);
  editor.append(input, row);
  textEl.append(editor);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

async function saveEditMessage(id, content) {
  content = content.trim();
  if (!content) return cancelEditMessage(id);
  try {
    const res = await api(`/api/messages/${id}`, { method: 'PATCH', body: { content } });
    const index = state.messages.findIndex((m) => m.id === id);
    if (index >= 0) state.messages[index] = res.message;
    const node = $('msg-list').querySelector(`[data-mid="${id}"] .msg-text`);
    if (node) {
      node.innerHTML = '';
      node.append(renderRichText(res.message.content));
      if (res.message.editedAt) node.append(el('span', 'edited-mark', ' (düzenlendi)'));
      node.classList.add('edited');
    }
  } catch (error) {
    toast(tr(error.message));
  }
  editingMessageId = null;
}

function cancelEditMessage(id) {
  const message = state.messages.find((m) => m.id === id);
  const node = $('msg-list').querySelector(`[data-mid="${id}"] .msg-text`);
  if (node && message) {
    node.innerHTML = '';
    node.append(renderRichText(message.content));
    if (message.editedAt) node.append(el('span', 'edited-mark', ' (düzenlendi)'));
  }
  editingMessageId = null;
}

function removeMessage(id) {
  $('msg-list').querySelector(`[data-mid="${id}"]`)?.remove();
  state.messages = state.messages.filter((m) => m.id !== id);
}

/* ==================== GÖNDERME ==================== */
const composer = $('in-msg');

composer.addEventListener('input', () => {
  composer.style.height = 'auto';
  composer.style.height = `${Math.min(composer.scrollHeight, 132)}px`;
  if (state.socket?.readyState === WebSocket.OPEN && state.channel) {
    const now = Date.now();
    if (!composer._lastTyping || now - composer._lastTyping > 3000) {
      composer._lastTyping = now;
      state.socket.send(JSON.stringify({ op: 'typing', channelId: state.channel.id }));
    }
  }
});

composer.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && window.innerWidth >= 820 && $('mention-list').hidden) {
    event.preventDefault();
    $('form-send').requestSubmit();
  }
});

$('form-send').addEventListener('submit', async (event) => {
  event.preventDefault();
  const content = composer.value.trim();
  if (!content && !state.uploading.length) return;
  if (!state.channel) return;
  const ids = state.uploading.map((a) => a.id);
  composer.value = '';
  composer.style.height = 'auto';
  state.uploading = [];
  renderAttachPreview();
  try {
    await api(`/api/channels/${state.channel.id}/messages`, {
      method: 'POST',
      body: { content, attachmentIds: ids }
    });
  } catch (error) {
    toast(tr(error.message));
    composer.value = content;
  }
});

$('btn-attach').addEventListener('click', () => $('in-file').click());

$('in-file').addEventListener('change', async (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  for (const file of files) {
    if (!state.channel) return;
    if (file.size > 8 * 1024 * 1024) {
      toast(`${file.name} 8 MB sınırını aşıyor`);
      continue;
    }
    const chip = el('span', 'attach-chip', `⏳ ${file.name}`);
    $('attach-preview').append(chip);
    $('attach-preview').hidden = false;
    try {
      const res = await fetch(
        `/api/channels/${state.channel.id}/upload?name=${encodeURIComponent(file.name)}&mime=${encodeURIComponent(file.type || 'application/octet-stream')}`,
        { method: 'POST', body: file, credentials: 'same-origin' }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'upload_failed');
      state.uploading.push(data.attachment);
      chip.textContent = `📎 ${file.name}`;
      renderAttachPreview();
    } catch (error) {
      chip.remove();
      toast(tr(error.message, 'Dosya yüklenemedi'));
    }
  }
});

function renderAttachPreview() {
  const box = $('attach-preview');
  box.innerHTML = '';
  for (const att of state.uploading) {
    const chip = el('span', 'attach-chip');
    chip.append(el('span', null, `📎 ${att.filename}`));
    const remove = el('button', null, '×');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      state.uploading = state.uploading.filter((a) => a.id !== att.id);
      renderAttachPreview();
    });
    chip.append(remove);
    box.append(chip);
  }
  box.hidden = !state.uploading.length;
}

/* ==================== @BAHSETME ==================== */
const mentionList = $('mention-list');
let mentionQuery = '';
let mentionIndex = 0;

function mentionCandidates() {
  const q = mentionQuery.toLowerCase();
  const users = Array.from(state.users.values())
    .filter((u) => u.id !== state.me.id && u.username?.toLowerCase().includes(q))
    .slice(0, 8);
  return users;
}

function renderMentionList() {
  const users = mentionCandidates();
  if (!users.length) { mentionList.hidden = true; return; }
  mentionList.innerHTML = '';
  users.forEach((u, i) => {
    const item = el('button', 'mention-item' + (i === mentionIndex ? ' active' : ''));
    item.type = 'button';
    item.append(avatarNode(u, 'xs'));
    item.append(el('span', null, u.displayName));
    item.append(el('small', 'muted', `@${u.username}`));
    item.addEventListener('click', () => insertMention(u));
    mentionList.append(item);
  });
  mentionList.hidden = false;
}

function insertMention(user) {
  const composer = $('in-msg');
  const before = composer.value.slice(0, composer.selectionStart);
  const after = composer.value.slice(composer.selectionEnd);
  const at = before.lastIndexOf('@');
  const prefix = before.slice(0, at);
  composer.value = `${prefix}@${user.username} ${after}`;
  composer.focus();
  const pos = composer.value.length - after.length;
  composer.setSelectionRange(pos, pos);
  mentionList.hidden = true;
  composer.dispatchEvent(new Event('input'));
}

composer.addEventListener('input', () => {
  const pos = composer.selectionStart;
  const before = composer.value.slice(0, pos);
  const at = before.lastIndexOf('@');
  if (at >= 0 && !before.slice(at + 1).includes(' ')) {
    mentionQuery = before.slice(at + 1);
    mentionIndex = 0;
    renderMentionList();
  } else {
    mentionList.hidden = true;
  }
});

composer.addEventListener('keydown', (event) => {
  if (!mentionList.hidden) {
    const users = mentionCandidates();
    if (event.key === 'ArrowDown') { event.preventDefault(); mentionIndex = (mentionIndex + 1) % users.length; renderMentionList(); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); mentionIndex = (mentionIndex - 1 + users.length) % users.length; renderMentionList(); return; }
    if (event.key === 'Enter' && users[mentionIndex]) { event.preventDefault(); insertMention(users[mentionIndex]); return; }
    if (event.key === 'Escape') { mentionList.hidden = true; return; }
  }
  if (event.key === 'Enter' && !event.shiftKey && window.innerWidth >= 820) {
    event.preventDefault();
    $('form-send').requestSubmit();
  }
});

/* ==================== GIF EKLEME ==================== */
const gifPanel = $('gif-panel');
const gifGrid = $('gif-grid');
let gifTimer = null;

$('btn-gif').addEventListener('click', () => {
  gifPanel.hidden = !gifPanel.hidden;
  if (!gifPanel.hidden) {
    $('gif-search').focus();
    gifAra($('gif-search').value || 'populer');
  }
});
$('btn-gif-close').addEventListener('click', () => { gifPanel.hidden = true; });
$('gif-search').addEventListener('input', () => {
  clearTimeout(gifTimer);
  gifTimer = setTimeout(() => gifAra($('gif-search').value), 400);
});

async function gifAra(q) {
  if (!q.trim()) return;
  gifGrid.innerHTML = '<p class="muted">Aranıyor...</p>';
  try {
    const data = await api(`/api/gifs/search?q=${encodeURIComponent(q)}`);
    gifGrid.innerHTML = '';
    if (!data.gifs?.length) {
      gifGrid.append(el('p', 'muted', 'Sonuç bulunamadı'));
      return;
    }
    for (const gif of data.gifs) {
      const img = el('img');
      img.loading = 'lazy';
      img.src = gif.preview;
      img.alt = 'GIF';
      img.addEventListener('click', () => gifEkle(gif));
      gifGrid.append(img);
    }
  } catch {
    gifGrid.innerHTML = '<p class="muted">GIF servisine ulaşılamadı</p>';
  }
}

async function gifEkle(gif) {
  gifPanel.hidden = true;
  try {
    const res = await fetch(gif.url);
    const blob = await res.blob();
    const file = new File([blob], `gif-${Date.now()}.gif`, { type: 'image/gif' });
    const up = await fetch(
      `/api/channels/${state.channel.id}/upload?name=${encodeURIComponent(file.name)}&mime=image/gif`,
      { method: 'POST', body: file, credentials: 'same-origin' }
    );
    const data = await up.json();
    if (!up.ok) throw new Error(data.error || 'upload_failed');
    state.uploading.push(data.attachment);
    renderAttachPreview();
    toast('GIF eklendi — göndermek için Enter');
  } catch {
    toast('GIF eklenemedi');
  }
}

/* ==================== SESLİ MESAJ ==================== */
let voiceRec = null;
let voiceRecChunks = [];
let voiceRecTimer = null;
const btnVoiceMsg = $('btn-voice-msg');

btnVoiceMsg.addEventListener('click', async () => {
  if (voiceRec) { stopVoiceRec(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voiceRec = new MediaRecorder(stream);
    voiceRecChunks = [];
    voiceRec.addEventListener('dataavailable', (e) => { if (e.data.size) voiceRecChunks.push(e.data); });
    voiceRec.addEventListener('stop', () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(voiceRecTimer);
      btnVoiceMsg.classList.remove('rec');
      const blob = new Blob(voiceRecChunks, { type: 'audio/webm' });
      if (blob.size > 0) sendVoiceMessage(blob);
    });
    voiceRec.start();
    btnVoiceMsg.classList.add('rec');
    toast('Kayıt başladı — bitirmek için tekrar tıkla');
    voiceRecTimer = setInterval(() => {
      if (voiceRec && voiceRec.state === 'recording' && voiceRecChunks.reduce((s, c) => s + c.size, 0) > 8 * 1024 * 1024) {
        stopVoiceRec();
      }
    }, 1000);
  } catch {
    toast('Mikrofona erişilemedi');
  }
});

function stopVoiceRec() {
  if (voiceRec && voiceRec.state !== 'inactive') voiceRec.stop();
}

async function sendVoiceMessage(blob) {
  try {
    const up = await fetch(
      `/api/channels/${state.channel.id}/upload?name=sesli-mesaj.webm&mime=audio/webm`,
      { method: 'POST', body: blob, credentials: 'same-origin' }
    );
    const data = await up.json();
    if (!up.ok) throw new Error(data.error || 'upload_failed');
    await api(`/api/channels/${state.channel.id}/messages`, {
      method: 'POST',
      body: { content: '', attachmentIds: [data.attachment.id] }
    });
    toast('Sesli mesaj gönderildi');
  } catch {
    toast('Sesli mesaj gönderilemedi');
  }
}

/* ==================== SAĞ SOHBET PANELİ ==================== */
let cside = {
  acik: false,
  mesajlar: [],
  kanal: null
};

/// Biri odaya girip çıkınca ya da giriş yapılınca çalınan minik uyarı sesi.
let minikCtx = null
let odaAudio = null
function minikCtxAl() {
  if (!minikCtx) minikCtx = new (window.AudioContext || window.webkitAudioContext)()
  return minikCtx
}
window.addEventListener('pointerdown', () => {
  const ctx = minikCtxAl()
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  if (!odaAudio) {
    odaAudio = new Audio('/ses/oda.mp3')
    odaAudio.volume = 0.45
    odaAudio.load()
  }
}, { passive: true })

/// Giriş ve çıkışta aynı çalınan kısa (0.2 sn) yumuşak uyarı sesi.
function minikSesCal() {
  try {
    if (!odaAudio) {
      odaAudio = new Audio('/ses/oda.mp3')
      odaAudio.volume = 0.45
    }
    odaAudio.currentTime = 0
    const p = odaAudio.play()
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        try {
          const ctx = minikCtxAl()
          if (ctx.state === 'suspended') ctx.resume()
          const t0 = ctx.currentTime
          const o = ctx.createOscillator()
          const g = ctx.createGain()
          o.type = 'sine'
          o.frequency.setValueAtTime(880, t0)
          g.gain.setValueAtTime(0.0001, t0)
          g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.015)
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18)
          o.connect(g).connect(ctx.destination)
          o.start(t0)
          o.stop(t0 + 0.2)
        } catch {}
      })
    }
  } catch {
    try {
      const ctx = minikCtxAl()
      if (ctx.state === 'suspended') ctx.resume()
      const t0 = ctx.currentTime
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.setValueAtTime(880, t0)
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.015)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18)
      o.connect(g).connect(ctx.destination)
      o.start(t0)
      o.stop(t0 + 0.2)
    } catch {}
  }
}

function chatSideTikla() {
  cside.acik = !cside.acik;
  chatSideCiz();
}

function chatSideKapat() {
  cside.acik = false;
  chatSideCiz();
}

function chatSideCiz() {
  const panel = $('chat-side');
  if (!panel) return;
  panel.hidden = !cside.acik;
  document.body.classList.toggle('cside-acik', cside.acik);
  const dugme = $('btn-chat-side');
  if (dugme) dugme.classList.toggle('active', cside.acik);
  if (cside.acik) {
    chatSideKanalDoldur();
    chatSideListele();
    chatSideGecmisiYukle();
  }
}

/// "Yazılacak kanal" seçicisini tüm erişilebilir metin kanallarıyla doldurur.
function chatSideKanalDoldur() {
  const sec = $('cside-chan');
  if (!sec) return;
  const seciliId = cside.kanal ?? state.channel?.id;
  sec.innerHTML = '';
  const kanallar = currentChannels().filter((c) => c.type === 'text');
  for (const k of kanallar) {
    const opt = el('option', null, `# ${k.name}`);
    opt.value = String(k.id);
    sec.append(opt);
  }
  if (seciliId && kanallar.some((k) => k.id === seciliId)) sec.value = String(seciliId);
  else if (kanallar.length) sec.value = String(kanallar[0].id);
  cside.kanal = Number(sec.value) || null;
}

function chatSideKanalSec() {
  const sec = $('cside-chan');
  if (!sec) return;
  cside.kanal = Number(sec.value) || null;
  cside.mesajlar = [];
  chatSideListele();
  chatSideGecmisiYukle();
}

/// Sağ sohbet panelinden mesaj gönderir (seçili kanala).
async function chatSideGonder() {
  const alan = $('cside-input');
  if (!alan) return;
  const content = alan.value.trim();
  if (!content) return;
  if (!cside.kanal) {
    toast('Önce yazılacak bir kanal seç');
    return;
  }
  alan.value = '';
  alan.style.height = 'auto';
  try {
    await api(`/api/channels/${cside.kanal}/messages`, { method: 'POST', body: { content } });
  } catch (error) {
    toast(tr(error.message));
    alan.value = content;
  }
}

async function chatSideGecmisiYukle() {
  if (!cside.kanal) return;
  try {
    const veri = await api(`/api/channels/${cside.kanal}/messages?limit=30`);
    if (cside.kanal !== Number($('cside-chan')?.value)) return;
    cside.mesajlar = veri.messages || [];
    if (cside.acik) chatSideListele();
  } catch {}
}

function chatSideMesajGeldi(message) {
  if (!cside.acik || cside.kanal !== message.channelId) return;
  cside.mesajlar.push(message);
  if (cside.mesajlar.length > 80) cside.mesajlar.shift();
  chatSideListele(false);
}

function chatSideSil(id) {
  const once = cside.mesajlar.length;
  cside.mesajlar = cside.mesajlar.filter((m) => m.id !== id);
  if (once !== cside.mesajlar.length && cside.acik) chatSideListele(false);
}

function chatSideListele(autoScroll = true) {
  const kutu = $('cside-msgs');
  if (!kutu) return;
  if (!cside.kanal) {
    kutu.replaceChildren(el('p', 'cside-bos', 'Yazılacak bir kanal seç'));
    return;
  }
  if (!cside.mesajlar.length) {
    kutu.replaceChildren(el('p', 'cside-bos', 'Bu kanalda henüz mesaj yok'));
    return;
  }
  const dibeYakin = kutu.scrollHeight - kutu.scrollTop - kutu.clientHeight < 140;
  const parca = document.createDocumentFragment();
  for (const m of cside.mesajlar) {
    const kart = el('div', 'cside-msg');
    const kullanici = state.users.get(m.userId);
    kart.append(el('span', 'cside-name', kullanici?.displayName || 'Bilinmeyen'));
    if (m.content) kart.append(renderRichText(m.content));
    for (const f of m.attachments || []) {
      if (f.mime?.startsWith('audio/')) {
        const audio = el('audio');
        audio.controls = true;
        audio.preload = 'metadata';
        audio.src = f.url;
        audio.style.width = '100%';
        audio.style.maxWidth = '240px';
        audio.style.height = '32px';
        kart.append(audio);
      } else if (f.mime?.startsWith('image/')) {
        const img = el('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = f.url;
        img.alt = f.filename;
        img.style.maxWidth = '100%';
        img.style.maxHeight = '160px';
        img.style.borderRadius = '8px';
        img.style.marginTop = '4px';
        img.style.cursor = 'pointer';
        img.addEventListener('click', () => window.open(f.url, '_blank', 'noopener'));
        kart.append(img);
      } else {
        const a = el('a', 'cside-file', `📄 ${f.filename}`);
        a.href = f.url;
        a.target = '_blank';
        a.rel = 'noopener';
        kart.append(a);
      }
    }
    kart.append(el('span', 'cside-time', fmtTime(m.createdAt)));
    parca.append(kart);
  }
  kutu.replaceChildren(parca);
  if (autoScroll || dibeYakin) kutu.scrollTop = kutu.scrollHeight;
}

/* ==================== WEBSOCKET ==================== */
function setNet(status) {
  const badge = $('net-badge');
  badge.className = `net-badge ${status}`;
  badge.title = { on: 'Bağlı', off: 'Bağlantı yok', warn: 'Yeniden bağlanıyor' }[status] || '';
}

function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/ws`);
  state.socket = socket;
  setNet('warn');

  socket.addEventListener('open', () => {
    state.reconnectDelay = 1000;
    setNet('on');
  });

  socket.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleSocket(msg);
  });

  socket.addEventListener('close', (event) => {
    setNet('off');
    if (ciz.acik) cizKapat();
    if (event.code === 4001 || event.code === 4003) {
      toast('Bu oturum kapatıldı');
      setTimeout(() => location.reload(), 1200);
      return;
    }
    const delay = state.reconnectDelay;
    state.reconnectDelay = Math.min(delay * 2, 15000);
    setTimeout(connectSocket, delay);
  });

  socket.addEventListener('error', () => setNet('off'));
}

function handleSocket(msg) {
  switch (msg.op) {
    case 'message_create': {
      const message = msg.payload;
      if (message.channelId === state.channel?.id && !state.messages.some((m) => m.id === message.id)) {
        appendMessage(message);
      }
      chatSideMesajGeldi(message);
      break;
    }
    case 'message_update': {
      const message = msg.payload;
      const index = state.messages.findIndex((m) => m.id === message.id);
      if (index >= 0) state.messages[index] = message;
      if (message.channelId === state.channel?.id) {
        const node = $('msg-list').querySelector(`[data-mid="${message.id}"] .msg-text`);
        if (node && editingMessageId !== message.id) {
          node.innerHTML = '';
          node.append(renderRichText(message.content));
          if (message.editedAt) node.append(el('span', 'edited-mark', ' (düzenlendi)'));
          node.classList.add('edited');
        }
      }
      break;
    }
    case 'mention': {
      const p = msg.payload;
      if (p.channelId === state.channel?.id) {
        toast(`🔔 ${p.from?.displayName || 'Biri'} seni etiketledi: ${p.content}`);
      } else {
        toast(`🔔 ${p.from?.displayName || 'Biri'} seni #${p.channelName} kanalında etiketledi`);
      }
      break;
    }
    case 'message_delete':
      removeMessage(msg.payload.id);
      chatSideSil(msg.payload.id);
      break;
    case 'typing': {
      if (msg.channelId !== state.channel?.id) break;
      state.typing.set(msg.userId, { name: msg.displayName, at: Date.now() });
      renderTyping();
      break;
    }
    case 'presence': {
      if (msg.online) state.online.add(msg.userId);
      else state.online.delete(msg.userId);
      renderMembersSide();
      break;
    }
    case 'voice_state': {
      const oncekiler = state.voice[msg.channelId] || [];
      const yeniGiren = (msg.users || []).filter((u) => u.userId !== state.me?.id && !oncekiler.some((x) => x.userId === u.userId));
      const cikanlar = oncekiler.filter((u) => u.userId !== state.me?.id && !(msg.users || []).some((x) => x.userId === u.userId));
      state.voice[msg.channelId] = msg.users || [];
      if (!msg.users?.length) delete state.voice[msg.channelId];
      renderChannels();
      renderVoice();
      renderMembersSide();
      // Başka biri odaya girip çıkınca minik uyarı sesi çal (kendi katılımında değil ve yalnızca odadakilere).
      if ((yeniGiren.length || cikanlar.length) && voice.channelId && Number(voice.channelId) === Number(msg.channelId)) {
        minikSesCal();
      }
      break;
    }
    case 'user_create':
    case 'user_update': {
      if (msg.payload) state.users.set(msg.payload.id, { ...state.users.get(msg.payload.id), ...msg.payload });
      if (msg.payload?.id === state.me?.id) {
        state.me = { ...state.me, ...msg.payload };
      }
      renderMe();
      renderMembersSide();
      break;
    }
    case 'user_delete':
      state.users.delete(msg.payload.userId);
      break;
    case 'refresh':
      refreshBootstrap();
      break;
    case 'kicked':
      toast('Bir yönetici seni attı');
      setTimeout(() => location.reload(), 1500);
      break;
    case 'draw_state': {
      if (Number(msg.channelId) !== ciz.kanal) break;
      ciz.renk = msg.me || ciz.renk;
      ciz.strokes = Array.isArray(msg.strokes) ? msg.strokes : [];
      ciz.katilimcilar = Array.isArray(msg.users) ? msg.users : [];
      cizYenidenCiz();
      cizKatilimciListesi();
      cizRenkSec();
      break;
    }
    case 'draw_users': {
      if (Number(msg.channelId) !== ciz.kanal) break;
      ciz.katilimcilar = Array.isArray(msg.users) ? msg.users : [];
      cizKatilimciListesi();
      break;
    }
    case 'draw_stroke': {
      if (Number(msg.channelId) !== ciz.kanal) break;
      const stroke = msg.stroke;
      if (!stroke || !Array.isArray(stroke.points) || !stroke.points.length) break;
      if (ciz.strokes.some((s) => s.id === stroke.id)) break;
      ciz.strokes.push(stroke);
      cizCiz(stroke);
      break;
    }
    case 'draw_clear': {
      if (Number(msg.channelId) !== ciz.kanal) break;
      ciz.strokes = [];
      cizYenidenCiz();
      break;
    }
    case 'draw_full':
      toast('Çizim tahtası dolu (en fazla 10 kişi)');
      cizKapat();
      break;
    default:
      break;
  }
}

async function refreshBootstrap() {
  try {
    const boot = await api('/api/bootstrap');
    state.servers = boot.servers || [];
    state.users = new Map((boot.users || []).map((u) => [u.id, u]));
    state.voice = boot.voice || {};
    if (!state.servers.some((s) => s.id === state.serverId)) state.serverId = state.servers[0]?.id ?? null;
    renderServers();
    renderChannels();
    renderVoice();
    renderMembersSide();
    if (state.channel) {
      const still = currentChannels().find((c) => c.id === state.channel.id);
      if (still) {
        state.channel = still;
        $('head-chan').textContent = `# ${still.name}`;
        $('head-topic').textContent = still.topic || '';
      } else {
        const first = currentChannels().find((c) => c.type === 'text');
        if (first) await openChannel(first.id);
      }
    }
  } catch {}
}

function renderTyping() {
  const now = Date.now();
  for (const [userId, info] of state.typing) {
    if (now - info.at > 5000) state.typing.delete(userId);
  }
  const names = [...state.typing.values()].map((t) => t.name);
  const box = $('typing');
  if (!names.length) {
    box.hidden = true;
    box.textContent = '';
  } else {
    box.hidden = false;
    box.textContent = names.length === 1
      ? `${names[0]} yazıyor…`
      : `${names.length} kişi yazıyor…`;
  }
}
setInterval(renderTyping, 2000);

/* ==================== SESLİ ==================== */
async function loadVoiceModule() {
  if (!voice.mod) voice.mod = await import('/voice.js');
  return voice.mod;
}

async function joinVoice(channel) {
  if (!state.rtc.enabled) {
    toast('Sesli görüşme bu sunucuda henüz yapılandırılmamış');
    return;
  }
  if (voice.room) await voice.mod.leave();
  try {
    $('voice-label').textContent = `🔊 ${channel.name}`;
    $('voicebar').hidden = false;
    const mod = await loadVoiceModule();
    await mod.join({
      channelId: channel.id,
      url: state.rtc.url,
      onState: (patch) => {
        Object.assign(voice, patch);
        renderVoice();
        if (patch.deviceChangedAt) scheduleDeviceRefresh();
      },
      onError: (message) => toast(message),
      send: (payload) => {
        const socket = state.socket;
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
      }
    });
    // Kanal degisti: ses seviyeleri yeni katilimcilara yeniden uygulanacak.
    voice.applied = new Set();
    voice.facing = mod.getFacing?.() || voice.facing;
    // Çizim tahtası kanala bağlıdır: kanal değişince kapanır.
    if (ciz.acik && ciz.kanal !== channel.id) cizKapat();
    // Ses seviyesi ust siniri tarayiciya gore degisir: cikis cihazi secilebilen
    // tarayicilarda %200 (guclendirme), digerlerinde %100. Telefonlarda %100
    // sinirinda kalinir; boylece ses yonlendirmesi bozulmaz ve ses kulakliga gider.
    voice.maxVolume = mod.maxVolume || 2;
    $('audio-range').max = String(Math.round(voice.maxVolume * 100));
    renderVoice();
    await refreshDevices();
    // Konuşma modu tercihi korunur: açıksa seçili mod etkin başlar (VAD arka planda da çalışır).
    const konusmaAcik = masaustu && localStorage.getItem('sohbet.konusma.acik') === '1';
    if (konusmaAcik && voice.konusmaMod === 'vad') {
      voice.vad = Boolean(await voice.mod?.setVadEnabled?.(true, vadEsikDegeri(voice.vadEsik)));
    } else if (konusmaAcik) {
      voice.ptt = Boolean(await voice.mod?.setPttEnabled?.(true));
    }
    // Sağırlaştırma kanal değişince korunur (Discord'daki gibi).
    if (voice.sagir) voice.sagir = Boolean(await voice.mod?.setDeafened?.(true));
    renderVoice();
    minikSesCal();
  } catch (error) {
    console.error(error);
    toast('Sesli kanala bağlanılamadı: ' + (error.message || 'bilinmeyen hata'));
    $('voicebar').hidden = true;
  }
}

/// Kayitli ses seviyeleri (kisi bazli) tarayicida saklanir.
const VOL_KEY = 'sohbet.ses.seviyeleri';
function loadVolumes() {
  try {
    const raw = JSON.parse(localStorage.getItem(VOL_KEY) || '{}');
    voice.volumes = new Map(Object.entries(raw).map(([k, v]) => [k, Number(v)]));
  } catch {
    voice.volumes = new Map();
  }
}
function saveVolumes() {
  try {
    localStorage.setItem(VOL_KEY, JSON.stringify(Object.fromEntries(voice.volumes)));
  } catch {}
}
/// Ekran paylasimi sesinin kisi bazli seviyeleri (izleyen icin) ayri saklanir.
const EKRAN_VOL_KEY = 'sohbet.ekran.ses.seviyeleri';
function loadScreenVolumes() {
  try {
    const raw = JSON.parse(localStorage.getItem(EKRAN_VOL_KEY) || '{}');
    voice.screenVolumes = new Map(Object.entries(raw).map(([k, v]) => [k, Number(v)]));
  } catch {
    voice.screenVolumes = new Map();
  }
}
function saveScreenVolumes() {
  try {
    localStorage.setItem(EKRAN_VOL_KEY, JSON.stringify(Object.fromEntries(voice.screenVolumes)));
  } catch {}
}
loadVolumes();
loadScreenVolumes();
voice.micDevice = localStorage.getItem('sohbet.mikrofon') || '';
voice.camDevice = localStorage.getItem('sohbet.kamera') || '';
// Ekran paylasimi tercihleri (kalite / ses kaynagi / kodek) tarayicida saklanir.
voice.shareQuality = localStorage.getItem('sohbet.ekran.kalite') || '';
voice.shareAudio = localStorage.getItem('sohbet.ekran.ses') || '';
voice.shareCodec = localStorage.getItem('sohbet.ekran.kodek') || '';
// Kamera kalitesi de tarayicida saklanir.
voice.cameraQuality = localStorage.getItem('sohbet.kamera.kalite') || '';

/* Sesli arayüz artımlı (incremental) güncellenir: kutular ve kişi satırları
   yeniden OLUŞTURULMAZ. Tümünü silip yeniden kurmak, videoları her durum
   değişiminde yeniden bağlıyordu; mobilde yanıp sönme (blink), tam ekrandan
   atma ve bellek şişmesine bağlı çökme bunun sonucuydu. */
const voiceDom = {
  peers: new Map(),
  rows: new Map(),
  tiles: new Map(),
  maximized: null,
  pipUserId: null,
  deviceBusy: false
};

function renderVoice() {
  const bar = $('voicebar');
  const side = $('voice-side');
  const stage = $('vs-stage');
  const peers = $('voice-peers');
  const channelId = voice.channelId;

  if (!channelId) {
    bar.hidden = true;
    side.hidden = true;
    stage.hidden = true;
    peers.innerHTML = '';
    $('vs-people').innerHTML = '';
    // Yalnızca video kutularını kaldır; "Çiz" düğmesi sahnenin kalıcı
    // çocuğudur ve innerHTML temizliğiyle yok edilmemelidir.
    for (const child of [...stage.children]) {
      if (child !== $('btn-ciz')) child.remove();
    }
    voiceDom.peers.clear();
    voiceDom.rows.clear();
    voiceDom.tiles.clear();
    voiceDom.maximized = null;
    filmModuKapat();
    if (ciz.acik) cizKapat();
    renderMembersSide();
    return;
  }

  bar.hidden = false;
  // Ayarlar paneli kullanıcı açmadıkça kapalı kalır (btn-vs-side / btn-close-vside).
  const participants = state.voice[channelId] || [];
  $('voice-count').textContent = `${participants.length} kişi`;
  const activeSpeakers = new Set((voice.activeSpeakers || []).map(String));

  renderPeerChips(participants, activeSpeakers);
  renderSidePeople(participants, activeSpeakers);
  renderMembersSide();
  renderStage(participants);
  renderPip();
  applySavedVolumes(participants);
  videoTasarrufuUygula();

  voice.mod?.attachTracks?.();

  $('btn-mic').classList.toggle('on', Boolean(voice.mic));
  $('btn-cam').classList.toggle('on', Boolean(voice.cam));
  $('btn-share').classList.toggle('on', Boolean(voice.screen));
  $('btn-card')?.classList.toggle('on', Boolean(voice.mod?.isCardPublishing?.()));
  $('btn-mic').querySelector('span').textContent = voice.mic ? 'Mikrofon açık' : 'Mikrofon kapalı';
  // Sağırlaştırma: mikrofonu kapatır ve kimseyi duymazsın.
  const sagirBtn = $('btn-sagir');
  if (sagirBtn) {
    sagirBtn.classList.toggle('on', Boolean(voice.sagir));
    sagirBtn.querySelector('span').textContent = voice.sagir ? 'Sağırlaştırıldı' : 'Sağırlaştır';
  }
  $('btn-cam').querySelector('span').textContent = voice.cam ? 'Kamera açık' : 'Kamera';
  $('btn-share').querySelector('span').textContent = voice.screen ? 'Paylaşım açık' : 'Ekran';
  $('btn-card')?.querySelector('span') && ($('btn-card').querySelector('span').textContent = voice.mod?.isCardPublishing?.() ? 'Kart açık' : 'Capture card');

  // Bas konuş / ses algılama yalnızca masaüstünde gösterilir (klavye gerekir).
  const pttBtn = $('btn-ptt');
  if (pttBtn) {
    const vadMi = voice.konusmaMod === 'vad';
    const konusmaAcik = Boolean(voice.ptt || voice.vad);
    pttBtn.hidden = !masaustu;
    pttBtn.classList.toggle('on', konusmaAcik);
    pttBtn.classList.toggle('live', Boolean(konusmaAcik && voice.mic));
    const tus = PTT_TUSLAR[voice.pttKey] || 'Boşluk';
    pttBtn.querySelector('span').textContent = vadMi
      ? (!voice.vad ? 'Ses algılama' : (voice.mic ? 'Konuşuyorsun...' : 'Ses algılama açık'))
      : (!voice.ptt ? 'Bas konuş' : (voice.mic ? 'Konuşuyorsun...' : `Bas konuş: ${tus}`));
  }

  // Ön/arka kamera çevirme yalnızca kamera açıkken ve birden fazla kamera varsa.
  const flip = $('btn-flip');
  flip.hidden = !(voice.cam && voice.cameraCount > 1);
  flip.querySelector('span').textContent = voice.facing === 'environment' ? 'Ön kamera' : 'Arka kamera';

  // Flaş yalnızca kamera açıkken ve cihaz destekliyorsa gösterilir.
  const flash = $('btn-flash');
  if (flash) {
    flash.hidden = !(voice.cam && voice.torchAvailable);
    flash.classList.toggle('on', Boolean(voice.torch));
    flash.querySelector('span').textContent = voice.torch ? 'Flaş açık' : 'Flaş';
  }

  // Arka planda ses icin ekran uyanik tutuluyorsa kullaniciya bildirilir.
  const keep = $('vs-keepawake');
  if (keep) keep.hidden = !voice.wakeLock;

  // Tarayici ses oynatimi engellediyse tek dokunusla baslatilir.
  const audioBtn = $('btn-audio');
  if (audioBtn) audioBtn.hidden = !voice.needsTapForAudio;

  renderDeviceSelects();
  renderCameraSelects();
  renderShareSelects();
}

/// Sesli kanaldaki kişi rozetleri (alt çubuk). Var olan düğümler yeniden kullanılır.
function renderPeerChips(participants, activeSpeakers) {
  const box = $('voice-peers');
  const seen = new Set();
  for (const p of participants) {
    const id = String(p.userId);
    seen.add(id);
    const user = state.users.get(p.userId) || { displayName: 'Bilinmeyen', avatarColor: '#5865f2' };
    const isSelf = p.userId === state.me.id;
    const micOn = isSelf ? voice.mic : !p.muted;
    const camOn = isSelf ? voice.cam : p.video;
    const screenOn = isSelf ? voice.screen : p.screen;

    let chip = voiceDom.peers.get(id);
    if (!chip) {
      chip = el('div', 'peer');
      chip.tabIndex = 0;
      chip.append(avatarNode(user, 'sm'));
      chip.append(el('span', 'pname', ''));
      chip.append(el('div', 'picons'));
      chip.addEventListener('click', () => openAudioSheet(p.userId));
      box.append(chip);
      voiceDom.peers.set(id, chip);
    }

    const avatarKey = `${user.avatarColor || ''}|${user.displayName || ''}|${user.avatarUrl || user.avatar_url || ''}`;
    if (chip.dataset.avatar !== avatarKey) {
      chip.dataset.avatar = avatarKey;
      chip.querySelector('.avatar').replaceWith(avatarNode(user, 'sm'));
    }
    const label = isSelf ? 'Sen' : user.displayName;
    const nameEl = chip.querySelector('.pname');
    if (nameEl.textContent !== label) nameEl.textContent = label;

    chip.classList.toggle('speaking', activeSpeakers.has(id));

    const stateKey = `${micOn}${camOn}${screenOn}`;
    const icons = chip.querySelector('.picons');
    if (icons.dataset.state !== stateKey) {
      icons.dataset.state = stateKey;
      icons.innerHTML = '';
      if (!micOn) icons.append(el('span', 'pico mute', '🔇'));
      if (camOn) icons.append(el('span', 'pico vid', '🎥'));
      if (screenOn) icons.append(el('span', 'pico scr', '🖥'));
    }
  }
  for (const [id, chip] of voiceDom.peers) {
    if (!seen.has(id)) { chip.remove(); voiceDom.peers.delete(id); }
  }
}

/// Masaüstü yan panelindeki kişi satırları.
function renderSidePeople(participants, activeSpeakers) {
  const box = $('vs-people');
  const seen = new Set();
  for (const p of participants) {
    const id = String(p.userId);
    seen.add(id);
    const user = state.users.get(p.userId) || { displayName: 'Bilinmeyen', avatarColor: '#5865f2' };
    const isSelf = p.userId === state.me.id;
    const micOn = isSelf ? voice.mic : !p.muted;
    const camOn = isSelf ? voice.cam : p.video;
    const screenOn = isSelf ? voice.screen : p.screen;

    let row = voiceDom.rows.get(id);
    if (!row) {
      row = el('div', 'prow');
      row.append(avatarNode(user, 'sm'));
      const grow = el('div', 'grow');
      grow.append(el('strong', null, ''));
      grow.append(el('small', null, ''));
      row.append(grow);
      row.addEventListener('click', () => openAudioSheet(p.userId));
      box.append(row);
      voiceDom.rows.set(id, row);
    }
    const nameEl = row.querySelector('strong');
    const wantName = isSelf ? `${user.displayName} (sen)` : user.displayName;
    if (nameEl.textContent !== wantName) nameEl.textContent = wantName;
    const info = [micOn ? 'mikrofon açık' : 'sessiz', camOn ? 'kamera' : null, screenOn ? 'ekran' : null]
      .filter(Boolean).join(' · ');
    const smallEl = row.querySelector('small');
    const volume = voice.volumes.get(id);
    const volumeText = volume !== undefined && volume !== 1 ? ` · ses %${Math.round(volume * 100)}` : '';
    const wantInfo = info + volumeText;
    if (smallEl.textContent !== wantInfo) smallEl.textContent = wantInfo;
    row.classList.toggle('speaking', activeSpeakers.has(id));
  }
  for (const [id, row] of voiceDom.rows) {
    if (!seen.has(id)) { row.remove(); voiceDom.rows.delete(id); }
  }
}

/// Sağ taraftaki üye paneli (Discord stili).
function renderMembersSide() {
  const mList = $('members-list');
  const mTitle = $('members-title');
  if (!mList) return;
  mList.innerHTML = '';

  const activeChannel = state.channel;
  const voiceChannelId = voice.channelId ? Number(voice.channelId) : null;

  let voiceUsers = [];
  if (voiceChannelId && state.voice[voiceChannelId]) {
    voiceUsers = state.voice[voiceChannelId];
  } else if (activeChannel?.type === 'voice' && state.voice[activeChannel.id]) {
    voiceUsers = state.voice[activeChannel.id];
  }

  const activeSpeakers = new Set((voice.activeSpeakers || []).map(String));

  if (voiceUsers.length > 0) {
    if (mTitle) mTitle.textContent = `Üyeler — ${voiceUsers.length}`;
    const vGroup = el('div', 'members-group-title', 'Sesli Oda');
    mList.append(vGroup);

    for (const p of voiceUsers) {
      const user = state.users.get(p.userId) || { displayName: 'Bilinmeyen', avatarColor: '#5865f2' };
      const isSelf = p.userId === state.me.id;
      const isSpeaking = activeSpeakers.has(String(p.userId));
      const isBot = Boolean(user.isBot || user.username === 'muzik-botu');

      const item = el('div', 'member-item' + (isSpeaking ? ' speaking' : ''));
      const wrap = el('div', 'avatar-wrap');
      wrap.append(avatarNode(user, 'sm'));
      const dot = el('span', 'status-dot online');
      wrap.append(dot);
      item.append(wrap);

      const minfo = el('div', 'minfo');
      const mhead = el('div', 'mhead');
      const mname = el('span', 'mname', user.displayName + (isSelf ? ' (Sen)' : ''));
      mhead.append(mname);
      const tag = roleTagNode(user.role, isBot);
      if (tag) mhead.append(tag);
      minfo.append(mhead);

      let subText = 'Çevrimiçi';
      let subClass = 'msub';
      if (isBot) {
        subText = 'Müzik çalıyor 🎵';
        subClass = 'msub music';
      } else if (isSpeaking) {
        subText = 'Konuşuyor...';
        subClass = 'msub speaking';
      } else if (!p.mic) {
        subText = 'Mikrofon kapalı';
      } else if (user.status) {
        subText = user.status;
      }
      const msub = el('span', subClass, subText);
      minfo.append(msub);
      item.append(minfo);

      if (!isSelf) {
        item.addEventListener('click', () => openAudioSheet(p.userId));
        item.title = 'Ses seviyesini ayarla';
      }
      mList.append(item);
    }
  } else {
    const srv = currentServer();
    const members = srv?.members || [];
    const count = members.length || state.users.size;
    if (mTitle) mTitle.textContent = `Üyeler — ${count}`;

    const online = [];
    const offline = [];

    const memberList = members.length ? members : Array.from(state.users.values()).map((u) => ({ userId: u.id, ...u }));
    for (const m of memberList) {
      const u = state.users.get(m.userId) || m;
      const isOnline = state.online.has(u.id);
      if (isOnline) online.push(u);
      else offline.push(u);
    }

    if (online.length) {
      mList.append(el('div', 'members-group-title', `Çevrimiçi — ${online.length}`));
      for (const u of online) {
        const item = el('div', 'member-item');
        const wrap = el('div', 'avatar-wrap');
        wrap.append(avatarNode(u, 'sm'));
        wrap.append(el('span', 'status-dot online'));
        item.append(wrap);

        const minfo = el('div', 'minfo');
        const mhead = el('div', 'mhead');
        mhead.append(el('span', 'mname', u.displayName + (u.id === state.me.id ? ' (Sen)' : '')));
        const isBot = Boolean(u.isBot || u.username === 'muzik-botu');
        const tag = roleTagNode(u.role, isBot);
        if (tag) mhead.append(tag);
        minfo.append(mhead);
        minfo.append(el('span', 'msub' + (isBot ? ' music' : ''), isBot ? 'Müzik Botu' : (u.status || 'Çevrimiçi')));
        item.append(minfo);
        mList.append(item);
      }
    }

    if (offline.length) {
      mList.append(el('div', 'members-group-title', `Çevrimdışı — ${offline.length}`));
      for (const u of offline) {
        const item = el('div', 'member-item');
        const wrap = el('div', 'avatar-wrap');
        wrap.append(avatarNode(u, 'sm'));
        wrap.append(el('span', 'status-dot offline'));
        item.append(wrap);

        const minfo = el('div', 'minfo');
        const mhead = el('div', 'mhead');
        mhead.append(el('span', 'mname', u.displayName));
        const isBot = Boolean(u.isBot || u.username === 'muzik-botu');
        const tag = roleTagNode(u.role, isBot);
        if (tag) mhead.append(tag);
        minfo.append(mhead);
        minfo.append(el('span', 'msub', 'Çevrimdışı'));
        item.append(minfo);
        mList.append(item);
      }
    }
  }
}

/// Kamera ve ekran paylaşımı kutuları. Kutular korunur; video öğesi yerinde kalır.
function renderStage(participants) {
  const stage = $('vs-stage');
  const want = [];
  for (const p of participants) {
    if (p.userId === state.me.id) {
      if (voice.screen) want.push({ key: `screen-${p.userId}`, kind: 'screen', userId: p.userId });
      if (voice.cam) want.push({ key: `cam-${p.userId}`, kind: 'cam', userId: p.userId });
    } else {
      if (p.screen) want.push({ key: `screen-${p.userId}`, kind: 'screen', userId: p.userId });
      if (p.video) want.push({ key: `cam-${p.userId}`, kind: 'cam', userId: p.userId });
    }
  }

  const seen = new Set();
  want.forEach((item, index) => {
    seen.add(item.key);
    let tile = voiceDom.tiles.get(item.key);
    if (!tile) {
      tile = el('div', item.kind === 'screen' ? 'tile screen' : 'tile');
      tile.id = `tile-${item.kind}-${item.userId}`;
      tile.append(el('span', 'tname', ''));
      if (item.kind === 'screen') {
        // Goruntu orani dugmesi: Sigidir -> Doldur -> Gercek. Siyah seritleri
        // kaldiramak icin izleyen kendi ekranina gore secim yapar.
        const fit = el('button', 'tfit', 'Sigidir');
        fit.type = 'button';
        fit.setAttribute('aria-label', 'Ekran paylaşımı görüntü oranı');
        fit.addEventListener('click', (event) => {
          event.stopPropagation();
          ekranFitDegistir(item.userId);
        });
        tile.append(fit);

        if (item.userId !== state.me.id) {
          const vol = el('button', 'tvol', '🔊');
          vol.type = 'button';
          vol.setAttribute('aria-label', 'Yayın sesi');
          vol.addEventListener('click', (event) => {
            event.stopPropagation();
            openAudioSheet(item.userId);
          });
          tile.append(vol);
        }
      }
      const btn = el('button', 'tmax', '⤢');
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Tam ekran');
      tile.append(btn);
      tile.addEventListener('click', () => toggleMaximize(item.key));
      stage.append(tile);
      voiceDom.tiles.set(item.key, tile);
    }
    if (item.kind === 'screen') ekranFitUygula(tile, item.userId);
    const user = state.users.get(item.userId);
    const who = item.userId === state.me.id ? 'Sen' : (user?.displayName || '');
    const label = item.kind === 'screen' ? `${who} ekranı` : who;
    const nameEl = tile.querySelector('.tname');
    if (nameEl.textContent !== label) nameEl.textContent = label;
    tile.classList.toggle('max', voiceDom.maximized === item.key);
    // Sıralama: ekran paylaşımı en üstte. Yalnızca gerekiyorsa taşınır.
    if (stage.children[index] !== tile) {
      stage.insertBefore(tile, stage.children[index] || null);
    }
  });

  for (const [key, tile] of voiceDom.tiles) {
    if (!seen.has(key)) {
      tile.remove();
      voiceDom.tiles.delete(key);
      if (voiceDom.maximized === key) {
        voiceDom.maximized = null;
        filmModuKapat();
      }
    }
  }
  // Sahne sesli kanaldayken her zaman görünür: video yokken ortadaki "Çiz"
  // düğmesi oyunu başlatır, video varken çıkışın tam ortasında durur.
  stage.hidden = !voice.channelId;
  stage.classList.toggle('bos', want.length === 0);
  const cizBtn = $('btn-ciz');
  if (cizBtn && !stage.contains(cizBtn)) stage.append(cizBtn);
}

/* ==================== PIP KAMERA (ekran paylaşımı tam ekrandayken) ==================== */
/// Ekran paylaşımı büyütülmüşken sağ üstte küçük kamera penceresi gösterilir.
/// Kamerası açık olan konuşan biri varsa onun kamerası; kimse konuşmuyorsa
/// kamerası açık olanlar arasından rastgele (5 sn'de bir değişen) kamera.
function pipAdaylar(participants) {
  return participants.filter((p) => (p.userId === state.me.id ? voice.cam : p.video));
}

function renderPip() {
  const pip = $('pip-cam');
  if (!pip) return;
  const kapat = () => {
    pip.hidden = true;
    document.body.classList.remove('pip-acik');
    voiceDom.pipUserId = null;
    voice.mod?.detachPip?.();
  };
  const maxKey = voiceDom.maximized;
  const ekranMax = maxKey && String(maxKey).startsWith('screen-');
  if (!ekranMax) {
    kapat();
    return;
  }
  const participants = state.voice[voice.channelId] || [];
  const adaylar = pipAdaylar(participants);
  if (!adaylar.length) {
    kapat();
    return;
  }
  const konusanlar = new Set((voice.activeSpeakers || []).map(String));
  const konusanAday = adaylar.find((p) => konusanlar.has(String(p.userId)));
  const secilen = konusanAday ? konusanAday.userId : (voiceDom.pipUserId || adaylar[0].userId);
  if (voiceDom.pipUserId !== secilen) {
    voiceDom.pipUserId = secilen;
    voice.mod?.detachPip?.();
    voice.mod?.attachPip?.(secilen);
    const user = state.users.get(secilen);
    const nameEl = $('pip-name');
    if (nameEl) nameEl.textContent = user?.displayName || '';
  }
  pip.hidden = false;
  document.body.classList.add('pip-acik');
}

/// Kimse konuşmuyorken kamerası açık olanlar arasında rastgele döner.
setInterval(() => {
  if (!voiceDom.maximized || !String(voiceDom.maximized).startsWith('screen-')) return;
  const participants = state.voice[voice.channelId] || [];
  const adaylar = pipAdaylar(participants);
  if (!adaylar.length) return;
  const konusanlar = new Set((voice.activeSpeakers || []).map(String));
  if (adaylar.some((p) => konusanlar.has(String(p.userId)))) return;
  const secilen = adaylar[Math.floor(Math.random() * adaylar.length)].userId;
  if (secilen !== voiceDom.pipUserId) {
    voiceDom.pipUserId = secilen;
    voice.mod?.detachPip?.();
    voice.mod?.attachPip?.(secilen);
    const user = state.users.get(secilen);
    const nameEl = $('pip-name');
    if (nameEl) nameEl.textContent = user?.displayName || '';
  }
}, 5000);

/// Ekran paylaşımı görüntü oranı (izleyene özel, tarayıcıda saklanır):
/// 'contain' sigidir (serit olabilir), 'cover' doldurur (kenarlardan kırpar,
/// serit kalmaz), 'auto' gerçek boyut. Varsayilan: doldur -> siyah serit yok.
const EKRAN_FIT_KEY = 'sohbet.ekran.fit';
const EKRAN_FIT_MODES = ['contain', 'cover', 'auto'];
const EKRAN_FIT_LABELS = { contain: 'Sigidir', cover: 'Doldur', auto: 'Gercek' };
function loadEkranFits() {
  try {
    const raw = JSON.parse(localStorage.getItem(EKRAN_FIT_KEY) || '{}');
    voice.screenFits = new Map(Object.entries(raw));
  } catch {
    voice.screenFits = new Map();
  }
}
function saveEkranFits() {
  try {
    localStorage.setItem(EKRAN_FIT_KEY, JSON.stringify(Object.fromEntries(voice.screenFits)));
  } catch {}
}
loadEkranFits();

function ekranFitSecimi(userId) {
  const v = voice.screenFits?.get(String(userId));
  return EKRAN_FIT_MODES.includes(v) ? v : 'cover';
}

function ekranFitUygula(tile, userId) {
  const secim = ekranFitSecimi(userId);
  tile.classList.toggle('fit-cover', secim === 'cover');
  tile.classList.toggle('fit-auto', secim === 'auto');
  const video = tile.querySelector('video');
  if (video) video.style.objectFit = secim === 'contain' ? 'contain' : '';
  const dugme = tile.querySelector('.tfit');
  if (dugme) dugme.textContent = EKRAN_FIT_LABELS[secim];
}

function ekranFitDegistir(userId) {
  const key = String(userId);
  const simdi = ekranFitSecimi(userId);
  const sonraki = EKRAN_FIT_MODES[(EKRAN_FIT_MODES.indexOf(simdi) + 1) % EKRAN_FIT_MODES.length];
  voice.screenFits.set(key, sonraki);
  saveEkranFits();
  const tile = voiceDom.tiles.get(`screen-${userId}`);
  if (tile) ekranFitUygula(tile, userId);
  toast(`Ekran görüntüsü: ${EKRAN_FIT_LABELS[sonraki]}`);
}

/// Görünmeyen video yayınlarını askıya alır (veri tasarrufu): film modunda ya
/// da bir kutu büyütüldüğünde ekranda yalnızca o kişi görünür olduğu için
/// diğer kameraların indirilmesi durdurulur. Sesler ve ekran paylaşımı etkilenmez.
/// Sekme arka plana atıldığında (telefon kilidi vb.) tüm kameralar durur.
function videoTasarrufuUygula() {
  const mod = voice.mod;
  if (!mod?.setVisibleCameras) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    mod.setVisibleCameras([]);
    return;
  }
  if (!voiceDom.maximized) {
    mod.setVisibleCameras(null);
    return;
  }
  const [tur, id] = String(voiceDom.maximized).split('-');
  // Kamera büyütülmüşse yalnızca o kişinin kamerası iner.
  if (tur === 'cam') {
    mod.setVisibleCameras([id]);
    return;
  }
  // Ekran paylaşımı büyütülmüş: PIP'te gösterilen kullanıcının kamerası iner,
  // diğerleri durur. (Anahtar biçimi: cam-{id} / screen-{id})
  mod.setVisibleCameras(voiceDom.pipUserId ? [String(voiceDom.pipUserId)] : []);
}

/// Kayıtlı kişi ses seviyelerini yeni katılımcılara uygular (bir kez).
function applySavedVolumes(participants) {
  if (!voice.mod?.setRemoteVolume) return;
  for (const p of participants) {
    const id = String(p.userId);
    if (voice.applied.has(id)) continue;
    voice.applied.add(id);
    const value = voice.volumes.get(id);
    if (value !== undefined) voice.mod.setRemoteVolume(p.userId, value);
    const ekran = voice.screenVolumes.get(id);
    if (ekran !== undefined) voice.mod.setScreenVolume?.(p.userId, ekran);
  }
}

/// Kutuyu uygulama içi tam ekrana alır. Öğe taşınmaz, yalnızca CSS sınıfı
/// değişir; bu yüzden görüntü yeniden bağlanmaz ve yanıp sönme olmaz.
function toggleMaximize(key) {
  voiceDom.maximized = voiceDom.maximized === key ? null : key;
  for (const [k, tile] of voiceDom.tiles) {
    tile.classList.toggle('max', k === voiceDom.maximized);
  }
  if (voiceDom.maximized) {
    // Film modu: sağda sohbet paneli sabitlenir, telefonda ekran yatay kilitlenir.
    document.body.classList.add('film-modu');
    cside.acik = true;
    chatSideCiz();
    try {
      const o = screen.orientation;
      if (o && typeof o.lock === 'function') o.lock('landscape').catch(() => {});
    } catch {}
  } else {
    filmModuKapat();
  }
  renderPip();
  // Görünmeyen kameraların indirilmesini durdur (veri tasarrufu).
  videoTasarrufuUygula();
  // Tam ekran ISTEGI KUTUYA degil, dokumanin kendisine yapilir: bir bilesen
  // tam ekrana alindiginda tarayici yalnizca onu ciziyor, bu yuzden sagdaki
  // sohbet paneli (film modu) gorunmez oluyordu. Dokuman tam ekraninda .tile.max
  // sabit konumla ekranin %75'ini, .chat-side kalan %25'ini kaplar.
  try {
    if (voiceDom.maximized && document.fullscreenEnabled && !document.fullscreenElement) {
      document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
    } else if (!voiceDom.maximized && document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    }
  } catch {}
}

/// Film modundan çıkar: sınıf kalkar, mobilde sağ panel kapatılır, kilit açılır.
function filmModuKapat() {
  if (!document.body.classList.contains('film-modu')) return;
  document.body.classList.remove('film-modu');
  try {
    const o = screen.orientation;
    if (o && typeof o.unlock === 'function') o.unlock();
  } catch {}
  if (!window.matchMedia('(min-width:820px)').matches) {
    cside.acik = window.matchMedia('(min-width:820px)').matches;
    chatSideCiz();
  }
  renderPip();
  // Film modundan çıkıldı: duraklatılan kameralar yeniden indirilir.
  videoTasarrufuUygula();
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && voiceDom.maximized) {
    voiceDom.maximized = null;
    for (const tile of voiceDom.tiles.values()) tile.classList.remove('max');
    filmModuKapat();
  }
});

/* ---- Bas konuş (push-to-talk): yalnızca bilgisayarda ---- */
/// Bas konuş için eşik değeri: hassasiyet (0-100) -> RMS eşiği (0.002-0.154).
function vadEsikDegeri(hassasiyet) {
  const v = Math.max(0, Math.min(100, Number(hassasiyet) || 0)) / 100;
  return Number((0.004 + Math.pow(1 - v, 2) * 0.15).toFixed(4));
}
function vadEsikAdi(hassasiyet) {
  const v = Number(hassasiyet) || 0;
  return v < 34 ? 'Düşük' : v < 67 ? 'Orta' : 'Yüksek';
}

/// Ayarlar panelindeki konuşma modu seçicisini doldurur.
function renderPttSelect() {
  const wrap = $('vs-ptt');
  if (!wrap) return;
  wrap.hidden = (currentVoiceTab !== 'ptt');
  if (!voice.room || !masaustu) return;
  fillSelect(
    $('sel-konusma-mod'),
    [
      { id: 'ptt', label: 'Bas konuş (tuşu basılı tut)' },
      { id: 'vad', label: 'Ses algılama (arka planda çalışır)' }
    ],
    voice.konusmaMod,
    'Mod yok'
  );
  voice.konusmaMod = $('sel-konusma-mod').value || 'ptt';
  const vadMi = voice.konusmaMod === 'vad';
  $('ptt-key-field').hidden = vadMi;
  $('vad-field').hidden = !vadMi;
  fillSelect(
    $('sel-ptt-key'),
    Object.entries(PTT_TUSLAR).map(([id, label]) => ({ id, label })),
    voice.pttKey,
    'Tuş yok'
  );
  const key = $('sel-ptt-key').value;
  if (key) voice.pttKey = key;
  // Gürültü engelleme anahtarı
  const gurultuSel = $('sel-gurultu');
  if (gurultuSel) {
    gurultuSel.value = voice.gurultu ? '1' : '0';
    gurultuSel.onchange = async () => {
      voice.gurultu = gurultuSel.value === '1';
      localStorage.setItem('sohbet.gurultu', voice.gurultu ? '1' : '0');
      await voice.mod?.setNoiseSuppression?.(voice.gurultu);
      toast(voice.gurultu ? 'Gürültü engelleme açık' : 'Gürültü engelleme kapalı');
    };
  }
  // Hassasiyet kaydırıcısı: yüksek = daha sessiz seste açar.
  const aralik = $('vad-range');
  if (aralik) aralik.value = String(voice.vadEsik);
  $('vad-val').textContent = vadEsikAdi(voice.vadEsik);
  voice.mod?.setVadThreshold?.(vadEsikDegeri(voice.vadEsik));
}

/// Yazı yazılan bir alanda mı? Bas konuş, mesaj yazarken mikrofonu açmamalı.
function pttYaziliyor() {
  const a = document.activeElement;
  if (!a) return false;
  const tag = a.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable === true;
}

function pttTusuMu(event) {
  if (event.code === voice.pttKey) return true;
  // Boşluk bazı tarayıcılarda yalnızca event.key=' ' ile gelir.
  return voice.pttKey === 'Space' && event.key === ' ';
}

/// Seçili konuşma modunu açar/kapatır ve tercihi saklar.
async function konusmaModuDegistir(zorla) {
  if (!voice.room || !masaustu) return;
  const aktif = voice.ptt || voice.vad;
  const hedef = zorla === undefined ? !aktif : Boolean(zorla);
  if (voice.konusmaMod === 'vad') {
    const sonuc = await voice.mod?.setVadEnabled?.(hedef, vadEsikDegeri(voice.vadEsik));
    voice.vad = Boolean(sonuc);
    voice.ptt = false;
  } else {
    const sonuc = await voice.mod?.setPttEnabled?.(hedef);
    voice.ptt = typeof sonuc === 'boolean' ? sonuc : hedef;
    voice.vad = false;
  }
  localStorage.setItem('sohbet.konusma.acik', (voice.ptt || voice.vad) ? '1' : '0');
  if (voice.vad) toast('Ses algılama açık — konuşunca mikrofon kendiliğinden açılır');
  else if (voice.ptt) toast(`Bas konuş açık — ${PTT_TUSLAR[voice.pttKey] || 'Boşluk'} tuşunu basılı tut`);
  else toast('Konuşma modu kapalı');
  renderVoice();
}

window.addEventListener('keydown', (event) => {
  if (!voice.ptt || !voice.channelId) return;
  if (!pttTusuMu(event)) return;
  if (pttYaziliyor()) return;
  // Sayfanın boşluk tuşuyla kaymasını engelle (basılı tutunca tekrar eder).
  event.preventDefault();
  if (event.repeat) return;
  voice.mod?.setPttHolding?.(true);
});
window.addEventListener('keyup', (event) => {
  if (!voice.ptt || !voice.channelId) return;
  if (!pttTusuMu(event)) return;
  if (pttYaziliyor()) return;
  voice.mod?.setPttHolding?.(false);
});
// Sekme/pencere odağı kaybolursa mikrofon açık kalmasın.
window.addEventListener('blur', () => {
  if (voice.ptt) voice.mod?.setPttHolding?.(false);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && voice.ptt) voice.mod?.setPttHolding?.(false);
});

$('btn-mic').addEventListener('click', async () => {
  voice.mod?.resumeAudio?.();
  // Sağırken mikrofon düğmesi önce sağırlaştırmayı kaldırır (mikrofon eski haline döner).
  if (voice.sagir) voice.sagir = Boolean(await voice.mod?.setDeafened?.(false));
  else await voice.mod?.toggleMic();
  renderVoice();
});
$('btn-sagir').addEventListener('click', async () => {
  voice.mod?.resumeAudio?.();
  const yeni = !voice.sagir;
  voice.sagir = Boolean(await voice.mod?.setDeafened?.(yeni));
  toast(voice.sagir ? 'Sağırlaştırıldı: mikrofon kapalı, kimseyi duymuyorsun' : 'Sağırlaştırma kaldırıldı');
  renderVoice();
});
$('btn-ptt').addEventListener('click', () => konusmaModuDegistir());
$('sel-konusma-mod')?.addEventListener('change', async () => {
  const eskiAktif = voice.ptt || voice.vad;
  const eskiMod = voice.ptt ? 'ptt' : (voice.vad ? 'vad' : null);
  voice.konusmaMod = $('sel-konusma-mod').value || 'ptt';
  localStorage.setItem('sohbet.konusma.mod', voice.konusmaMod);
  if (eskiMod) {
    // Mod değişince eskisi kapatılır; açıksa yeni mod kendiliğinden başlar.
    if (eskiMod === 'ptt') await voice.mod?.setPttEnabled?.(false);
    else await voice.mod?.setVadEnabled?.(false);
    voice.ptt = false;
    voice.vad = false;
  }
  renderPttSelect();
  if (eskiAktif) await konusmaModuDegistir(true);
  else {
    toast(voice.konusmaMod === 'vad' ? 'Mod: Ses algılama (arka planda çalışır)' : 'Mod: Bas konuş');
    renderVoice();
  }
});
$('sel-ptt-key')?.addEventListener('change', () => {
  voice.pttKey = $('sel-ptt-key').value || 'Space';
  localStorage.setItem('sohbet.ptt.tus', voice.pttKey);
  renderPttSelect();
  if (voice.ptt) {
    const tus = PTT_TUSLAR[voice.pttKey] || 'Boşluk';
    toast(`Konuşma tuşu: ${tus}`);
  }
  renderVoice();
});
$('vad-range')?.addEventListener('input', () => {
  voice.vadEsik = Number($('vad-range').value) || 0;
  localStorage.setItem('sohbet.vad.esik', String(voice.vadEsik));
  $('vad-val').textContent = vadEsikAdi(voice.vadEsik);
  // Eşik anında uygulanır: mod açıkken sürükleyince tepki hemen değişir.
  voice.mod?.setVadThreshold?.(vadEsikDegeri(voice.vadEsik));
});
$('btn-cam').addEventListener('click', async () => {
  voice.mod?.resumeAudio?.();
  await voice.mod?.toggleCam();
  refreshDevices();
});
$('btn-share').addEventListener('click', async () => {
  voice.mod?.resumeAudio?.();
  await voice.mod?.toggleScreen();
});
$('btn-card').addEventListener('click', async () => {
  voice.mod?.resumeAudio?.();
  let deviceId = voice.cardDevice || $('sel-card-device')?.value;
  if (!deviceId && cardDevices.length) deviceId = cardDevices[0].id;
  if (!deviceId) {
    const side = $('voice-side');
    side.hidden = false;
    side.classList.add('open');
    setVoiceTab('card');
    toast('Capture card bulunamadı veya bağlı değil');
    return;
  }
  voice.cardDevice = deviceId;
  localStorage.setItem('sohbet.kart', deviceId);
  const audio = $('sel-card-audio')?.value || voice.cardAudio;
  if (audio) {
    voice.cardAudio = audio;
    localStorage.setItem('sohbet.kart.ses', audio);
    voice.mod?.setCardAudioSource?.(audio);
  }
  await voice.mod?.toggleCaptureCard?.(deviceId);
  renderVoice();
});
$('btn-flip').addEventListener('click', async () => {
  voice.mod?.resumeAudio?.();
  const next = await voice.mod?.switchFacing?.();
  if (next) voice.facing = next;
  renderVoice();
  refreshDevices();
});
$('btn-leave').addEventListener('click', async () => {
  minikSesCal();
  await voice.mod?.leave();
  voice.channelId = null;
  voice.room = null;
  voice.applied = new Set();
  voiceDom.maximized = null;
  if (ciz.acik) cizKapat();
  renderVoice();
});

/* ==================== KİŞİ SES SEVİYESİ ==================== */
let audioTargetId = null;
let audioLastNonZero = 1;

/// Bir kişiye dokununca açılan ses paneli. Hem telefonda hem bilgisayarda çalışır.
function openAudioSheet(userId) {
  if (!voice.channelId) return;
  if (userId === state.me.id) {
    toast('Kendi sesini buradan ayarlayamazsın');
    return;
  }
  audioTargetId = userId;
  const user = state.users.get(userId);
  const stored = voice.volumes.get(String(userId));
  const limit = voice.maxVolume || 2;
  const raw = stored === undefined ? 1 : stored;
  const gain = Math.max(0, Math.min(limit, raw));
  if (gain > 0) audioLastNonZero = gain;
  $('audio-title').textContent = user?.displayName || 'Ses seviyesi';
  const limitPercent = Math.round(limit * 100);
  $('audio-sub').textContent = limitPercent > 100
    ? 'Bu kişinin sesini kıs veya yükselt. Ayar yalnızca seni etkiler.'
    : 'Bu kişinin sesini kıs veya yükselt. Ayar yalnızca seni etkiler. (Bu cihazda en fazla %100)';
  $('audio-range').max = String(limitPercent);
  $('audio-range').value = String(Math.round(gain * 100));
  $('audio-val').textContent = `${Math.round(gain * 100)}%`;
  $('btn-audio-mute').textContent = gain === 0 ? 'Sesi aç' : 'Sessize al';
  // Ekran paylasimi sesi: yalnizca bu kisinin ekran paylasimi varsa gosterilir.
  const alan = $('audio-ekran-field');
  const ekranDeger = voice.screenVolumes.get(String(userId)) ?? 1;
  const ekranVar = (state.voice[voice.channelId] || []).some(
    (u) => u.userId === userId && u.screen
  ) || voiceDom.tiles.has(`screen-${userId}`);
  if (alan) alan.hidden = !ekranVar;
  const ekranRange = $('audio-ekran-range');
  const ekranVal = $('audio-ekran-val');
  if (ekranRange) ekranRange.max = String(limitPercent);
  if (ekranRange) ekranRange.value = String(Math.round(Math.max(0, Math.min(limit, ekranDeger)) * 100));
  if (ekranVal) ekranVal.textContent = `${Math.round(ekranDeger * 100)}%`;
  $('screen-audio').hidden = false;
}

function applyScreenVolumeToUser(userId, gain) {
  const key = String(userId);
  const limit = voice.maxVolume || 2;
  const value = Math.max(0, Math.min(limit, gain));
  voice.screenVolumes.set(key, value);
  saveScreenVolumes();
  voice.mod?.resumeAudio?.();
  voice.mod?.setScreenVolume?.(userId, value);
  const ekranVal = $('audio-ekran-val');
  if (ekranVal) ekranVal.textContent = `${Math.round(value * 100)}%`;
}

function applyVolumeToUser(userId, gain) {
  const key = String(userId);
  const limit = voice.maxVolume || 2;
  const value = Math.max(0, Math.min(limit, gain));
  voice.volumes.set(key, value);
  saveVolumes();
  voice.mod?.resumeAudio?.();
  voice.mod?.setRemoteVolume?.(userId, value);
  $('audio-val').textContent = `${Math.round(value * 100)}%`;
  $('btn-audio-mute').textContent = value === 0 ? 'Sesi aç' : 'Sessize al';
  renderVoice();
}

$('audio-range').addEventListener('input', () => {
  if (!audioTargetId) return;
  const gain = Number($('audio-range').value) / 100;
  if (gain > 0) audioLastNonZero = gain;
  applyVolumeToUser(audioTargetId, gain);
});
$('audio-ekran-range')?.addEventListener('input', () => {
  if (!audioTargetId) return;
  applyScreenVolumeToUser(audioTargetId, Number($('audio-ekran-range').value) / 100);
});
$('btn-audio-mute').addEventListener('click', () => {
  if (!audioTargetId) return;
  const current = voice.volumes.get(String(audioTargetId));
  const now = current === undefined ? 1 : current;
  const next = now === 0 ? (audioLastNonZero || 1) : 0;
  $('audio-range').value = String(Math.round(next * 100));
  applyVolumeToUser(audioTargetId, next);
});
$('btn-audio-reset').addEventListener('click', () => {
  if (!audioTargetId) return;
  $('audio-range').value = '100';
  applyVolumeToUser(audioTargetId, 1);
});
$('btn-audio-close').addEventListener('click', () => { $('screen-audio').hidden = true; });

/* ==================== CİHAZ SEÇİMİ (MİKROFON / KAMERA) ==================== */
function fillSelect(select, items, selected, emptyLabel) {
  const current = selected || select.value || '';
  select.innerHTML = '';
  if (!items.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = emptyLabel;
    select.append(option);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.label;
    select.append(option);
  }
  // Saklanan cihaz hâlâ varsa onu, yoksa ilkini seç.
  select.value = items.some((item) => item.id === current) ? current : items[0].id;
}

let currentVoiceTab = 'devices';

function setVoiceTab(tab) {
  currentVoiceTab = tab;
  document.querySelectorAll('#vsettings-tabs .vtab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  const map = {
    devices: 'vs-devices',
    ptt: 'vs-ptt',
    camera: 'vs-camera',
    share: 'vs-share',
    card: 'vs-card'
  };
  for (const [t, id] of Object.entries(map)) {
    const elTab = $(id);
    if (elTab) elTab.hidden = (t !== currentVoiceTab);
  }
}

function renderDeviceSelects() {
  const wrap = $('vs-devices');
  if (wrap) wrap.hidden = (currentVoiceTab !== 'devices');
}

/// Kamera ayarlari (kalite). Secim kamerayi acarken ve acikken canli uygulanir.
function renderCameraSelects() {
  const wrap = $('vs-camera');
  const mod = voice.mod;
  if (!wrap) return;
  wrap.hidden = (currentVoiceTab !== 'camera');
  if (!voice.room || !mod?.getCameraSettings) return;
  const settings = mod.getCameraSettings();
  fillSelect(
    $('sel-cam-quality'),
    settings.qualities.map((item) => ({ id: item.key, label: item.label })),
    voice.cameraQuality || settings.quality,
    'Seçenek yok'
  );
  const quality = $('sel-cam-quality').value;
  // Yalnizca GERCEKTEN degistiyse uygula. Bu kontrol olmadan renderVoice'un her
  // cagrisi (ornegin konusan kisi degistikce) kamerayi yeniden baslatirdi.
  if (quality && quality !== settings.quality) {
    voice.cameraQuality = quality;
    mod.setCameraQuality?.(quality);
  }
}

/// Ekran paylasimi ayarlari (cozunurluk/kare hizi, ses kaynagi, kodek).
const SHARE_AUDIO_FIXED = [
  { id: 'sistem', label: 'Sistem sesi (paylaşırken seçilir)' },
  { id: 'yok', label: 'Ses gönderme' }
];

function renderShareSelects() {
  const wrap = $('vs-share');
  const mod = voice.mod;
  if (!wrap) return;
  wrap.hidden = (currentVoiceTab !== 'share');
  if (!voice.room || !mod?.getShareSettings) return;
  const settings = mod.getShareSettings();
  fillSelect(
    $('sel-share-quality'),
    settings.qualities.map((item) => ({ id: item.key, label: item.label })),
    voice.shareQuality || settings.quality,
    'Seçenek yok'
  );
  fillSelect(
    $('sel-share-codec'),
    settings.codecs.map((item) => ({ id: item.key, label: item.label })),
    voice.shareCodec || settings.codec,
    'Seçenek yok'
  );
  fillSelect(
    $('sel-share-audio'),
    [...SHARE_AUDIO_FIXED, ...(voice.shareMics || []).map((mic) => ({ id: 'aygit:' + mic.id, label: 'Aygıt: ' + mic.label }))],
    voice.shareAudio || settings.audioSource,
    'Ses seçilemedi'
  );
  // Kullanici bir secim yaptiysa onu modide uygula.
  const quality = $('sel-share-quality').value;
  const codec = $('sel-share-codec').value;
  const audio = $('sel-share-audio').value;
  voice.shareQuality = quality;
  voice.shareCodec = codec;
  voice.shareAudio = audio;
  // Yalnizca gercekten degisen ayarlar uygulanir; aksi halde her cizimde
  // yayina bos yere mudahale edilirdi.
  if (quality && quality !== settings.quality) mod.setShareQuality?.(quality);
  if (codec && codec !== settings.codec) mod.setShareCodec?.(codec);
  if (audio && audio !== settings.audioSource) mod.setShareAudioSource?.(audio);
  $('share-msg').hidden = true;
}

async function refreshDevices() {
  if (!voice.room || !voice.mod?.listDevices || voiceDom.deviceBusy) return;
  voiceDom.deviceBusy = true;
  try {
    const { mics, cams } = await voice.mod.listDevices();
    fillSelect($('sel-mic'), mics, voice.micDevice, 'Mikrofon bulunamadı');
    fillSelect($('sel-cam'), cams, voice.camDevice, 'Kamera bulunamadı');
    voice.cameraCount = cams.length;
    voiceDom.devicesReady = mics.length > 0 || cams.length > 0;
    voice.shareMics = mics;
  renderDeviceSelects();
  renderShareSelects();
  renderCameraSelects();
  refreshCardDevices();
  renderPttSelect();
  $('btn-flip').hidden = !(voice.cam && voice.cameraCount > 1);
  } catch (error) {
    console.error(error);
  } finally {
    voiceDom.deviceBusy = false;
  }
}

let deviceTimer = null;
function scheduleDeviceRefresh() {
  clearTimeout(deviceTimer);
  deviceTimer = setTimeout(() => { refreshDevices(); }, 700);
}

/* ---- Capture card ---- */
let cardDevices = [];

function renderCardSelects() {
  const wrap = $('vs-card');
  const mod = voice.mod;
  if (!wrap) return;
  wrap.hidden = (currentVoiceTab !== 'card');
  if (!voice.room || !mod?.getCardSettings) return;
  const settings = mod.getCardSettings();
  // Kart listesi: yalnizca gercekten capture card olan video aygitlari.
  const kartlar = cardDevices.filter((c) => /capture|hdmi|usb|elgato|aver|magewell|blackmagic|intensity|gamer|game/i.test(c.label));
  const havuz = kartlar.length ? kartlar : cardDevices;
  fillSelect($('sel-card-device'), havuz.map((c) => ({ id: c.id, label: c.label })), voice.cardDevice || '', 'Capture card bulunamadı');
  // Secili karti voice durumuna aktar ve sakla
  const secili = $('sel-card-device').value;
  voice.cardDevice = secili;
  if (secili) localStorage.setItem('sohbet.kart', secili);

  // Kart sesi: secili kartin ses aygitlari (hepsi liste icinde ayni havuzda).
  const kart = cardDevices.find((c) => c.id === secili);
  const sesler = kart?.audioDevices || [];

  // Eger henuz kart sesi secilmemisse, eslesen ses aygitini otomatik sec
  let seciliSes = voice.cardAudio;
  if (!seciliSes || seciliSes === 'yok') {
    const eslesen = sesler.find((s) => s.eslesiyor);
    if (eslesen) seciliSes = 'aygit:' + eslesen.id;
  }

  fillSelect(
    $('sel-card-audio'),
    [
      { id: 'yok', label: 'Ses gönderme' },
      ...sesler.map((s) => ({ id: 'aygit:' + s.id, label: s.label }))
    ],
    seciliSes || 'yok',
    'Ses aygıtı yok'
  );

  const audio = $('sel-card-audio').value;
  voice.cardAudio = audio;
  if (audio) {
    localStorage.setItem('sohbet.kart.ses', audio);
    mod.setCardAudioSource?.(audio);
  }

  fillSelect(
    $('sel-card-quality'),
    settings.qualities.map((q) => ({ id: q.key, label: q.label })),
    voice.cardQuality || settings.quality,
    'Seçenek yok'
  );
  fillSelect(
    $('sel-card-codec'),
    settings.codecs.map((c) => ({ id: c.key, label: c.label })),
    voice.cardCodec || settings.codec,
    'Seçenek yok'
  );
  const quality = $('sel-card-quality').value;
  const codec = $('sel-card-codec').value;
  voice.cardQuality = quality;
  voice.cardCodec = codec;
  if (quality && quality !== settings.quality) mod.setCardQuality?.(quality);
  if (codec && codec !== settings.codec) mod.setCardCodec?.(codec);
  $('card-msg').hidden = true;
}

async function refreshCardDevices() {
  if (!voice.room || !voice.mod?.listCaptureDevices) return;
  try {
    cardDevices = await voice.mod.listCaptureDevices();
    $('btn-card').hidden = !cardDevices.length;
    renderCardSelects();
  } catch {
    $('btn-card').hidden = true;
  }
}

$('sel-card-device')?.addEventListener('change', () => {
  voice.cardDevice = $('sel-card-device').value;
  localStorage.setItem('sohbet.kart', voice.cardDevice);
  renderCardSelects();
});
$('sel-card-audio')?.addEventListener('change', () => {
  voice.cardAudio = $('sel-card-audio').value;
  localStorage.setItem('sohbet.kart.ses', voice.cardAudio);
  renderCardSelects();
});
$('sel-card-quality')?.addEventListener('change', () => {
  voice.cardQuality = $('sel-card-quality').value;
  localStorage.setItem('sohbet.kart.kalite', voice.cardQuality);
  renderCardSelects();
});
$('sel-card-codec')?.addEventListener('change', () => {
  voice.cardCodec = $('sel-card-codec').value;
  localStorage.setItem('sohbet.kart.kodek', voice.cardCodec);
  renderCardSelects();
});

$('sel-mic').addEventListener('change', async (event) => {
  const deviceId = event.target.value;
  if (!deviceId) return;
  voice.micDevice = deviceId;
  localStorage.setItem('sohbet.mikrofon', deviceId);
  voice.mod?.resumeAudio?.();
  const ok = await voice.mod?.switchMicDevice?.(deviceId);
  toast(ok ? 'Mikrofon değiştirildi' : 'Mikrofon değiştirilemedi');
});
$('sel-cam').addEventListener('change', async (event) => {
  const deviceId = event.target.value;
  if (!deviceId) return;
  voice.camDevice = deviceId;
  localStorage.setItem('sohbet.kamera', deviceId);
  voice.mod?.resumeAudio?.();
  const ok = await voice.mod?.switchCamDevice?.(deviceId);
  toast(ok ? 'Kamera değiştirildi' : 'Kamera değiştirilemedi');
  refreshDevices();
});

/* ---- Ekran paylasimi ayarlari ---- */
$('sel-share-quality').addEventListener('change', async (event) => {
  const key = event.target.value;
  if (!key) return;
  voice.shareQuality = key;
  localStorage.setItem('sohbet.ekran.kalite', key);
  const ok = await voice.mod?.setShareQuality?.(key);
  // Paylasim surerken yakalama kisitlari canli uygulanir; yeni pencere acilmaz.
  if (voice.screen) toast(ok ? 'Ekran kalitesi güncellendi' : 'Kalite uygulanamadı, paylaşımı yeniden başlat');
});
$('sel-share-codec').addEventListener('change', (event) => {
  const key = event.target.value;
  if (!key) return;
  voice.shareCodec = key;
  localStorage.setItem('sohbet.ekran.kodek', key);
  voice.mod?.setShareCodec?.(key);
  if (voice.screen) toast('Kodek bir sonraki paylaşımda geçerli olacak');
});
$('sel-share-audio').addEventListener('change', (event) => {
  const value = event.target.value;
  if (!value) return;
  voice.shareAudio = value;
  localStorage.setItem('sohbet.ekran.ses', value);
  voice.mod?.setShareAudioSource?.(value);
  if (voice.screen) toast('Ses kaynağı bir sonraki paylaşımda geçerli olacak');
});

/* ---- Kamera ayarlari ---- */
$('sel-cam-quality').addEventListener('change', async (event) => {
  const key = event.target.value;
  if (!key) return;
  voice.cameraQuality = key;
  localStorage.setItem('sohbet.kamera.kalite', key);
  const ok = await voice.mod?.setCameraQuality?.(key);
  if (voice.cam) toast(ok ? 'Kamera kalitesi güncellendi' : 'Kalite uygulanamadı');
});
$('btn-flash').addEventListener('click', async () => {
  voice.mod?.resumeAudio?.();
  const on = await voice.mod?.toggleTorch?.();
  voice.torch = Boolean(on);
  renderVoice();
});
$('btn-audio').addEventListener('click', async () => {
  const ok = await voice.mod?.startAudioIfNeeded?.();
  if (ok) toast('Ses açıldı');
  renderVoice();
});
// Sekmeye/cama her donuste ses yeniden acilir (telefonda arka plandan donus).
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && voice.channelId) {
      voice.mod?.startAudioIfNeeded?.().then(() => renderVoice()).catch(() => {});
    }
    // Arka planda/ekran kapalıyken video indirilmez (veri ve batarya tasarrufu).
    videoTasarrufuUygula();
  });
}

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => scheduleDeviceRefresh());
}

/* ==================== ÇEKMECE / PANEL / HESAP ==================== */
function openSidebar() {
  $('sidebar').classList.add('open');
  $('sidebar-scrim').hidden = false;
}
function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('sidebar-scrim').hidden = true;
}
$('btn-menu').addEventListener('click', openSidebar);
$('btn-close-sidebar').addEventListener('click', closeSidebar);

/* ---------------- sağ sohbet + ses paneli ---------------- */
$('btn-chat-side').addEventListener('click', chatSideTikla);
$('btn-close-cside').addEventListener('click', chatSideKapat);
$('cside-chan').addEventListener('change', chatSideKanalSec);
$('cside-form').addEventListener('submit', (event) => {
  event.preventDefault();
  chatSideGonder();
});
$('cside-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    chatSideGonder();
  }
});
$('cside-input').addEventListener('input', () => {
  const alan = $('cside-input');
  alan.style.height = 'auto';
  alan.style.height = `${Math.min(alan.scrollHeight, 96)}px`;
});
$('btn-vs-side').addEventListener('click', () => {
  const panel = $('voice-side');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    setVoiceTab(currentVoiceTab);
    renderPttSelect();
  }
});
$('btn-close-vside').addEventListener('click', () => {
  $('voice-side').hidden = true;
});

document.querySelectorAll('#vsettings-tabs .vtab').forEach((btn) => {
  btn.addEventListener('click', () => {
    setVoiceTab(btn.dataset.tab);
    if (btn.dataset.tab === 'ptt') renderPttSelect();
    else if (btn.dataset.tab === 'camera') renderCameraSelects();
    else if (btn.dataset.tab === 'share') renderShareSelects();
    else if (btn.dataset.tab === 'card') renderCardSelects();
    else if (btn.dataset.tab === 'devices') renderDeviceSelects();
  });
});

$('btn-members-toggle')?.addEventListener('click', () => {
  const mside = $('members-side');
  if (mside) mside.hidden = !mside.hidden;
});
$('btn-close-mside')?.addEventListener('click', () => {
  const mside = $('members-side');
  if (mside) mside.hidden = true;
});

/* ---------------- sürükle-bırak yeniden boyutlandırma ---------------- */
function sabitleResize(kulp, hedef, snrlar, dikey) {
  let surukleniyor = false;
  let baslangic = 0;
  let baslangicBoyut = 0;
  const sinir = {
    min: snrlar?.min ?? 120,
    max: snrlar?.max ?? window.innerHeight * 0.9,
    birim: snrlar?.birim || 'px'
  };
  kulp.addEventListener('pointerdown', (event) => {
    surukleniyor = true;
    baslangic = dikey ? event.clientY : event.clientX;
    baslangicBoyut = dikey ? hedef.offsetHeight : hedef.offsetWidth;
    kulp.setPointerCapture(event.pointerId);
    kulp.classList.add('dragging');
    document.body.style.userSelect = 'none';
    event.preventDefault();
  });
  kulp.addEventListener('pointermove', (event) => {
    if (!surukleniyor) return;
    // Kulp kutunun ÜST kenarında: yukarı çekince kutu büyür, aşağı çekince küçülür.
    const delta = dikey ? baslangic - event.clientY : event.clientX - baslangic;
    let yeni = baslangicBoyut + delta;
    yeni = Math.max(sinir.min, Math.min(sinir.max, yeni));
    hedef.style.height = `${yeni}${sinir.birim}`;
    hedef.style.maxHeight = 'none';
  });
  const bitir = () => {
    if (!surukleniyor) return;
    surukleniyor = false;
    kulp.classList.remove('dragging');
    document.body.style.userSelect = '';
  };
  kulp.addEventListener('pointerup', bitir);
  kulp.addEventListener('pointercancel', bitir);
}

const vsKulp = $('vs-resize');
const vsSahne = $('vs-stage');
if (vsKulp && vsSahne) {
  const gorunum = () => { vsKulp.hidden = vsSahne.hidden; };
  new MutationObserver(gorunum).observe(vsSahne, { attributes: true, attributeFilter: ['hidden'] });
  gorunum();
  sabitleResize(vsKulp, vsSahne, { min: 90, max: window.innerHeight * 0.92, birim: 'px' }, true);
}
$('sidebar-scrim').addEventListener('click', closeSidebar);

function updateMeAvatarPreview() {
  const preview = $('me-avatar-preview');
  if (!preview) return;
  const me = state.me;
  const url = me?.avatarUrl || me?.avatar_url;
  if (url) {
    preview.style.backgroundImage = `url("${url}")`;
    preview.textContent = '';
    const btnRemove = $('btn-remove-avatar');
    if (btnRemove) btnRemove.hidden = false;
  } else {
    preview.style.backgroundImage = '';
    preview.style.background = me?.avatarColor || me?.avatar_color || '#5865f2';
    preview.textContent = initials(me?.displayName || '?');
    const btnRemove = $('btn-remove-avatar');
    if (btnRemove) btnRemove.hidden = true;
  }
}

$('btn-me').addEventListener('click', () => {
  $('me-display').value = state.me.displayName;
  $('me-status').value = state.me.status || '';
  $('me-theme').value = localStorage.getItem('sohbet.tema') || 'dark';
  $('me-color').value = state.me.avatarColor || '#5865f2';
  $('me-pass').value = '';
  updateMeAvatarPreview();
  // Davet kodu sunucudan sadece yonetici/sahip icin gelir; digerlerinde alan gizli kalir.
  const showInvite = Boolean(state.inviteCode);
  $('field-invite-code').hidden = !showInvite;
  $('me-invite').value = showInvite ? state.inviteCode : '';
  $('me-msg').hidden = true;
  $('screen-me').hidden = false;
});
$('btn-me-close').addEventListener('click', () => { $('screen-me').hidden = true; });

$('btn-choose-avatar')?.addEventListener('click', () => {
  $('in-avatar')?.click();
});

$('in-avatar')?.addEventListener('change', async () => {
  const file = $('in-avatar').files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    toast('Lütfen geçerli bir resim dosyası seçin');
    return;
  }
  if (file.size > 4 * 1024 * 1024) {
    toast('Resim en fazla 4 MB olabilir');
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    const preview = $('me-avatar-preview');
    if (preview) {
      preview.style.backgroundImage = `url("${e.target.result}")`;
      preview.textContent = '';
    }
  };
  reader.readAsDataURL(file);

  try {
    toast('Profil resmi yükleniyor...');
    const buffer = await file.arrayBuffer();
    const token = localStorage.getItem('sohbet.token');
    const res = await fetch(`/api/me/avatar?mime=${encodeURIComponent(file.type)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': file.type
      },
      body: buffer
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'upload_failed');
    state.me = { ...state.me, ...data.user, avatarUrl: data.avatarUrl };
    state.users.set(state.me.id, { ...state.users.get(state.me.id), ...data.user, avatarUrl: data.avatarUrl });
    renderMe();
    renderMembersSide();
    updateMeAvatarPreview();
    toast('Profil resmi güncellendi');
  } catch (err) {
    toast('Resim yüklenemedi: ' + tr(err.message));
    updateMeAvatarPreview();
  }
});

$('btn-remove-avatar')?.addEventListener('click', async () => {
  try {
    const token = localStorage.getItem('sohbet.token');
    const res = await fetch('/api/me/avatar', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'remove_failed');
    state.me = { ...state.me, ...data.user, avatarUrl: null };
    state.users.set(state.me.id, { ...state.users.get(state.me.id), ...data.user, avatarUrl: null });
    renderMe();
    renderMembersSide();
    updateMeAvatarPreview();
    toast('Profil resmi kaldırıldı');
  } catch (err) {
    toast('Resim kaldırılamadı: ' + tr(err.message));
  }
});

$('me-color')?.addEventListener('input', () => {
  if (!state.me?.avatarUrl) {
    const preview = $('me-avatar-preview');
    if (preview) preview.style.background = $('me-color').value;
  }
});

$('btn-copy-invite').addEventListener('click', async () => {
  const field = $('me-invite');
  if (!field.value) return;
  try {
    await navigator.clipboard.writeText(field.value);
    toast('Davet kodu kopyalandı');
  } catch {
    field.select();
    document.execCommand('copy');
    toast('Davet kodu kopyalandı');
  }
});
$('btn-me-save').addEventListener('click', async () => {
  const body = {
    displayName: $('me-display').value.trim(),
    avatarColor: $('me-color').value,
    status: $('me-status').value.trim()
  };
  const tema = $('me-theme').value;
  localStorage.setItem('sohbet.tema', tema);
  applyTheme(tema);
  if ($('me-pass').value) body.password = $('me-pass').value;
  try {
    const res = await api(`/api/users/${state.me.id}`, { method: 'PATCH', body });
    state.me = { ...state.me, ...res.user };
    state.users.set(state.me.id, { ...state.users.get(state.me.id), ...res.user });
    renderMe();
    renderMembersSide();
    $('me-msg').textContent = 'Kaydedildi';
    $('me-msg').hidden = false;
    $('me-pass').value = '';
    voice.mod?.updateIdentity?.(state.me.displayName);
  } catch (error) {
    $('me-msg').textContent = tr(error.message);
    $('me-msg').hidden = false;
  }
});

/* ==================== TEMALAR ==================== */
const THEMES = {
  dark: {
    '--bg': '#0d0e14', '--bg2': '#12131a', '--bg3': '#1a1c25', '--bg4': '#232633',
    '--line': '#2a2e3d', '--fg': '#e6e8ef', '--muted': '#8b90a4',
    '--brand': '#5865f2', '--ok': '#3ba55d', '--warn': '#faa61a', '--danger': '#ed4245', '--self': '#2b3a55'
  },
  light: {
    '--bg': '#f2f3f5', '--bg2': '#ffffff', '--bg3': '#e9eaee', '--bg4': '#dcdde2',
    '--line': '#d4d6dd', '--fg': '#1a1b22', '--muted': '#5c6070',
    '--brand': '#5865f2', '--ok': '#2d7d46', '--warn': '#b58105', '--danger': '#d83c3e', '--self': '#dbe4f5'
  },
  spiderman: {
    '--bg': '#0d0e14', '--bg2': '#1a0f14', '--bg3': '#241520', '--bg4': '#301a28',
    '--line': '#4a1f2e', '--fg': '#f0e6ea', '--muted': '#b08a96',
    '--brand': '#e23636', '--ok': '#3ba55d', '--warn': '#faa61a', '--danger': '#e23636', '--self': '#3a1a22'
  },
  superman: {
    '--bg': '#0d0e14', '--bg2': '#10141f', '--bg3': '#1a2133', '--bg4': '#232c45',
    '--line': '#2c3a5e', '--fg': '#e8ecf5', '--muted': '#8fa0c0',
    '--brand': '#e23b3b', '--ok': '#3ba55d', '--warn': '#f6c945', '--danger': '#e23b3b', '--self': '#2a3550'
  },
  deadpool: {
    '--bg': '#0d0e14', '--bg2': '#160f0f', '--bg3': '#221616', '--bg4': '#2e1c1c',
    '--line': '#4a2222', '--fg': '#f0e6e6', '--muted': '#b08a8a',
    '--brand': '#c0392b', '--ok': '#3ba55d', '--warn': '#faa61a', '--danger': '#c0392b', '--self': '#3a1a1a'
  }
};

function applyTheme(name) {
  const theme = THEMES[name] || THEMES.dark;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme)) root.style.setProperty(key, value);
  document.body.dataset.theme = name;
}

(function initTheme() {
  applyTheme(localStorage.getItem('sohbet.tema') || 'dark');
})();

$('btn-panel').addEventListener('click', async () => {
  $('screen-panel').hidden = false;
  await loadPanel();
});
$('btn-panel-close').addEventListener('click', () => { $('screen-panel').hidden = true; });
$('panel-tabs').addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  state.panelTab = tab.dataset.tab;
  [...$('panel-tabs').children].forEach((t) => t.classList.toggle('active', t === tab));
  await loadPanel();
});

async function loadPanel() {
  const body = $('panel-body');
  body.innerHTML = '<p class="muted">Yükleniyor…</p>';
  try {
    const data = await api('/api/panel/state');
    state.panelData = data;
    if (state.panelTab === 'audit') {
      const audit = await api('/api/audit?limit=120');
      data.audit = audit.entries;
    }
  } catch (error) {
    body.innerHTML = '';
    body.append(el('p', 'error', tr(error.message)));
    return;
  }
  body.innerHTML = '';
  const render = { users: renderPanelUsers, channels: renderPanelChannels, servers: renderPanelServers, audit: renderPanelAudit }[state.panelTab];
  render(body, state.panelData);
}

const ROLE_TR = { owner: 'Kurucu', admin: 'Yönetici', mod: 'Moderatör', member: 'Üye', guest: 'Misafir' };

function actionRow(node, label, handler, cls = '') {
  const button = el('button', `pbtn ${cls}`.trim(), label);
  button.type = 'button';
  button.addEventListener('click', handler);
  node.append(button);
  return button;
}

function renderPanelUsers(body, data) {
  const create = el('div', 'card');
  create.append(el('h3', null, 'Yeni kullanıcı'));
  const grid = el('div', 'grid2');
  const username = el('input');
  username.placeholder = 'kullanıcı adı';
  const display = el('input');
  display.placeholder = 'görünen ad';
  const password = el('input');
  password.type = 'password';
  password.placeholder = 'parola (min 8)';
  const role = el('select');
  for (const r of ['member', 'guest', 'mod', 'admin', 'owner']) {
    const option = el('option', null, ROLE_TR[r]);
    option.value = r;
    role.append(option);
  }
  for (const field of [username, display, password, role]) {
    const wrap = el('label', 'field');
    wrap.append(field);
    grid.append(wrap);
  }
  create.append(grid);
  const add = actionRow(create, 'Kullanıcı oluştur', async () => {
    try {
      await api('/api/users', {
        method: 'POST',
        body: {
          username: username.value.trim(),
          displayName: display.value.trim(),
          password: password.value,
          role: role.value
        }
      });
      toast('Kullanıcı oluşturuldu');
      await loadPanel();
    } catch (error) {
      toast(tr(error.message));
    }
  }, 'go');
  add.style.marginTop = '8px';
  body.append(create);

  const card = el('div', 'card');
  card.append(el('h3', null, `Kullanıcılar (${data.users.length})`));
  for (const user of data.users) {
    const row = el('div', 'prow');
    row.append(avatarNode(user, 'sm'));
    const grow = el('div', 'grow');
    grow.append(el('strong', null, user.displayName));
    grow.append(el('small', null, `@${user.username} · ${user.lastSeen ? 'son görülme ' + fmtTime(user.lastSeen) : 'hiç girmedi'}${user.disabled ? ' · DEVRE DIŞI' : ''}`));
    row.append(grow);
    row.append(el('span', `chip ${user.role}`, ROLE_TR[user.role]));
    if (state.online.has(user.id)) row.append(el('span', 'chip', 'çevrimiçi'));
    if (user.id !== state.me.id) {
      actionRow(row, user.disabled ? 'Aç' : 'Kapat', async () => {
        await api(`/api/users/${user.id}`, { method: 'PATCH', body: { disabled: !user.disabled } });
        await loadPanel();
      });
      actionRow(row, 'At', async () => {
        await api(`/api/users/${user.id}/kick`, { method: 'POST' });
        toast('Atıldı');
      });
      if (state.me.role === 'owner') {
        actionRow(row, 'Sil', async () => {
          if (!confirm(`${user.displayName} silinsin mi? Mesajları da silinir.`)) return;
          await api(`/api/users/${user.id}`, { method: 'DELETE' });
          await loadPanel();
        }, 'danger');
      }
      if (['owner', 'admin'].includes(state.me.role)) {
        const roleSelect = el('select', 'pbtn');
        for (const r of ['member', 'guest', 'mod', 'admin', 'owner']) {
          const option = el('option', null, ROLE_TR[r]);
          option.value = r;
          roleSelect.append(option);
        }
        roleSelect.value = user.role;
        roleSelect.addEventListener('change', async () => {
          try {
            await api(`/api/users/${user.id}`, { method: 'PATCH', body: { role: roleSelect.value } });
            toast('Rol güncellendi');
            await loadPanel();
          } catch (error) {
            toast(tr(error.message));
          }
        });
        row.append(roleSelect);
      }
    }
    card.append(row);
  }
  body.append(card);
}

function renderPanelChannels(body, data) {
  const canManage = ['owner', 'admin'].includes(state.me.role);
  if (canManage) {
    const create = el('div', 'card');
    create.append(el('h3', null, 'Yeni kanal'));
    const grid = el('div', 'grid2');
    const name = el('input');
    name.placeholder = 'kanal adı';
    const type = el('select');
    for (const t of ['text', 'voice']) {
      const option = el('option', null, t === 'text' ? 'Metin kanalı' : 'Sesli kanal');
      option.value = t;
      type.append(option);
    }
    const server = el('select');
    for (const s of data.servers) {
      const option = el('option', null, s.name);
      option.value = String(s.id);
      server.append(option);
    }
    const topic = el('input');
    topic.placeholder = 'konu (opsiyonel)';
    for (const field of [name, type, server, topic]) {
      const wrap = el('label', 'field');
      wrap.append(field);
      grid.append(wrap);
    }
    create.append(grid);
    const add = actionRow(create, 'Kanal oluştur', async () => {
      try {
        await api('/api/channels', {
          method: 'POST',
          body: {
            name: name.value.trim(),
            type: type.value,
            serverId: Number(server.value),
            topic: topic.value.trim()
          }
        });
        toast('Kanal oluşturuldu');
        await loadPanel();
      } catch (error) {
        toast(tr(error.message));
      }
    }, 'go');
    add.style.marginTop = '8px';
    body.append(create);
  }

  for (const server of data.servers) {
    const card = el('div', 'card');
    card.append(el('h3', null, server.name));
    const channels = data.channels.filter((c) => c.serverId === server.id);
    if (!channels.length) card.append(el('p', 'muted', 'Kanal yok'));
    for (const channel of channels) {
      const row = el('div', 'prow');
      const grow = el('div', 'grow');
      const ikon = channel.type === 'voice' ? '🔊' : '#';
      const etiket = channel.type === 'voice' ? 'sesli' : 'metin';
      grow.append(el('strong', null, `${ikon} ${channel.name}`));
      grow.append(el('small', null, `${etiket}${channel.isPrivate ? ' · özel (' + channel.access.length + ' kişi)' : ' · herkese açık'}`));
      row.append(grow);
      if (canManage) {
        actionRow(row, 'Yeniden adlandır', async () => {
          const value = prompt('Yeni ad', channel.name);
          if (!value) return;
          await api(`/api/channels/${channel.id}`, { method: 'PATCH', body: { name: value } });
          await loadPanel();
        });
        actionRow(row, 'Sil', async () => {
          if (!confirm(`#${channel.name} kanalı ve içindeki tüm mesajlar silinsin mi?`)) return;
          await api(`/api/channels/${channel.id}`, { method: 'DELETE' });
          await loadPanel();
        }, 'danger');
      }
      card.append(row);
    }
    body.append(card);
  }
}

function renderPanelServers(body, data) {
  const card = el('div', 'card');
  card.append(el('h3', null, 'Sunucular'));
  for (const server of data.servers) {
    const row = el('div', 'prow');
    const grow = el('div', 'grow');
    grow.append(el('strong', null, server.name));
    grow.append(el('small', null, `${server.memberCount} üye · ${server.messageCount} mesaj`));
    row.append(grow);
    if (state.me.role === 'owner') {
      actionRow(row, 'Adı değiştir', async () => {
        const value = prompt('Yeni sunucu adı', server.name);
        if (!value) return;
        await api(`/api/servers/${server.id}`, { method: 'PATCH', body: { name: value } });
        await loadPanel();
      });
    }
    card.append(row);
  }
  body.append(card);

  if (state.me.role === 'owner') {
    const create = el('div', 'card');
    create.append(el('h3', null, 'Yeni sunucu'));
    const input = el('input');
    input.placeholder = 'sunucu adı';
    const wrap = el('label', 'field');
    wrap.append(input);
    create.append(wrap);
    actionRow(create, 'Sunucu oluştur', async () => {
      if (!input.value.trim()) return;
      await api('/api/servers', { method: 'POST', body: { name: input.value.trim() } });
      toast('Sunucu oluşturuldu');
      await loadPanel();
    }, 'go');
    body.append(create);
  }
}

function renderPanelAudit(body, data) {
  const card = el('div', 'card');
  card.append(el('h3', null, 'Son işlemler'));
  if (!data.audit?.length) card.append(el('p', 'muted', 'Kayıt yok'));
  for (const entry of data.audit || []) {
    const row = el('div', 'log-row');
    row.append(el('time', null, fmtTime(entry.createdAt)));
    const actor = state.users.get(entry.actorId);
    row.append(el('span', null, `${actor?.displayName || 'sistem'} → ${entry.action}${entry.detail ? ' ' + JSON.stringify(entry.detail) : ''}`));
    card.append(row);
  }
  body.append(card);
}

/* ==================== ORTAK ÇİZİM TAHTASI ==================== */
function cizGonder(payload) {
  const socket = state.socket;
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function cizAc() {
  if (!voice.channelId) {
    toast('Önce bir sesli kanala gir');
    return;
  }
  if (ciz.acik) return;
  ciz.acik = true;
  ciz.kanal = Number(voice.channelId);
  ciz.strokes = [];
  ciz.katilimcilar = [];
  ciz.ctx = $('ciz-canvas').getContext('2d');
  cizYenidenCiz();
  cizKatilimciListesi();
  $('screen-ciz').hidden = false;
  cizGonder({ op: 'draw_join', channelId: ciz.kanal });
}

function cizKapat() {
  if (!ciz.acik) return;
  cizGonder({ op: 'draw_leave', channelId: ciz.kanal });
  ciz.acik = false;
  ciz.kanal = null;
  ciz.renk = '';
  ciz.strokes = [];
  ciz.katilimcilar = [];
  ciz.ciziyor = false;
  ciz.aktif = null;
  ciz.ctx = null;
  $('screen-ciz').hidden = true;
}

function cizCiz(stroke) {
  const ctx = ciz.ctx;
  if (!ctx || !stroke?.points?.length) return;
  const canvas = $('ciz-canvas');
  const W = canvas.width;
  const H = canvas.height;
  const pts = stroke.points;
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0][0] * W, pts[0][1] * H);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * W, pts[i][1] * H);
  ctx.stroke();
}

function cizYenidenCiz() {
  const canvas = $('ciz-canvas');
  const ctx = ciz.ctx;
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const stroke of ciz.strokes) cizCiz(stroke);
}

function cizKatilimciListesi() {
  const kutu = $('ciz-katilimcilar');
  kutu.innerHTML = '';
  $('ciz-count').textContent = `${ciz.katilimcilar.length}/10 kişi`;
  for (const k of ciz.katilimcilar) {
    const chip = el('span', 'ciz-kisi' + (k.userId === state.me?.id ? ' sen' : ''));
    const nokta = el('span', 'nokta', '');
    nokta.style.background = k.color;
    chip.append(nokta);
    chip.append(document.createTextNode(k.userId === state.me?.id ? 'Sen' : (k.name || '?')));
    kutu.append(chip);
  }
}

function cizNokta(event) {
  const rect = $('ciz-canvas').getBoundingClientRect();
  return [
    Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
  ];
}

/// Renk paleti: herkes kendi rengiyle çizer; sunucu rengi atayınca
/// (draw_state) yalnızca o renk seçilebilir kalır.
function cizRenkPaleti() {
  const kutu = $('ciz-renkler');
  kutu.innerHTML = '';
  for (const renk of DRAW_RENKLER) {
    const btn = el('button', 'ciz-renk', '');
    btn.type = 'button';
    btn.style.background = renk;
    btn.setAttribute('aria-label', `Renk ${renk}`);
    btn.addEventListener('click', () => {
      if (ciz.renk && ciz.renk !== renk) return;
      ciz.renk = renk;
      cizRenkSec();
    });
    kutu.append(btn);
  }
}

function cizRenkSec() {
  const kutu = $('ciz-renkler');
  kutu.querySelectorAll('.ciz-renk').forEach((b) => {
    const on = b.style.background === ciz.renk;
    b.classList.toggle('on', on);
    b.disabled = Boolean(ciz.renk) && !on;
  });
}

function cizBagla() {
  const canvas = $('ciz-canvas');
  canvas.addEventListener('pointerdown', (event) => {
    if (!ciz.acik || !ciz.renk) return;
    canvas.setPointerCapture(event.pointerId);
    ciz.ciziyor = true;
    ciz.son = cizNokta(event);
    ciz.aktif = {
      id: `${state.me?.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      color: ciz.renk,
      width: ciz.firca,
      points: [ciz.son]
    };
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!ciz.ciziyor || !ciz.aktif) return;
    const p = cizNokta(event);
    const onceki = ciz.son;
    if (onceki && Math.abs(p[0] - onceki[0]) < 0.001 && Math.abs(p[1] - onceki[1]) < 0.001) return;
    ciz.aktif.points.push(p);
    ciz.son = p;
    // Yerel parça anında çizilir; vuruş bırakılınca tamamı sunucuya gider.
    const ctx = ciz.ctx;
    const W = canvas.width;
    const H = canvas.height;
    ctx.strokeStyle = ciz.aktif.color;
    ctx.lineWidth = ciz.aktif.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(onceki[0] * W, onceki[1] * H);
    ctx.lineTo(p[0] * W, p[1] * H);
    ctx.stroke();
  });
  const bitir = () => {
    if (!ciz.ciziyor) return;
    ciz.ciziyor = false;
    const stroke = ciz.aktif;
    ciz.aktif = null;
    if (stroke && stroke.points.length > 1) {
      ciz.strokes.push(stroke);
      cizGonder({ op: 'draw_stroke', channelId: ciz.kanal, stroke });
    }
  };
  canvas.addEventListener('pointerup', bitir);
  canvas.addEventListener('pointercancel', bitir);
}

$('btn-ciz').addEventListener('click', cizAc);
$('btn-ciz-close').addEventListener('click', cizKapat);
$('btn-ciz-ayril').addEventListener('click', cizKapat);
$('btn-ciz-temizle').addEventListener('click', () => {
  if (!ciz.acik) return;
  cizGonder({ op: 'draw_clear', channelId: ciz.kanal });
});
$('ciz-firca').addEventListener('input', (event) => {
  ciz.firca = Number(event.target.value);
});
cizRenkPaleti();
cizBagla();

/* ==================== BAŞLAT ==================== */
window.addEventListener('resize', () => {
  if (window.innerWidth >= 820) closeSidebar();
});

startApp().catch((error) => {
  console.error(error);
  toast('Başlatılamadı: ' + (error.message || 'hata'));
});
