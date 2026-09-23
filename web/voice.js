/*
  LiveKit tabanli sesli / goruntulu / ekran paylasimi modulu.
  Bant genisligi hedefi: ses ~16 kbps mono, kamera 180p/360p simulcast,
  ekran paylasimi 1080p30 (simulcast ile 720p/360p'ye inebilir) + ekran sesi.
  SDK yalnizca sesli kanala ilk katilista yuklenir (metin kullanicilari 580 KB indirmez).
*/

const AUDIO_MAX_BITRATE = 16000;

// --- Ekran paylasimi -------------------------------------------------------
// Kullanicinin arayuzden sectigi on ayarlar.
//
// BIT HIZLARI: Onceden 1080p icin 3 Mbps kullaniliyordu ve metin belirgin
// sekilde yumusak/bulanik cikiyordu. VP8/VP9 ekran iceriginde (metin, arayuz)
// cozunurlukten once bit hizina takilir. Bu yuzden tavan genis tutulur;
// kodlayici zaten icerigin karmasikligina gore cok daha azini harcar.
//
// 'kaynak' secenegi: genis ideal deger verilir, tarayici kaynak ekrandan buyuk
// olcekleme yapmaz -> yakalama ekranin gercek cozunurlugunde olur. Boylece
// 1440p/4K ekranda 1080p'ye dusurulerek olusan bulaniklik onlenir.
const SHARE_QUALITIES = {
  '480p30': { label: '480p · 30 fps', width: 854, height: 480, frameRate: 30, bitrate: 1500000 },
  '720p30': { label: '720p · 30 fps', width: 1280, height: 720, frameRate: 30, bitrate: 3000000 },
  '1080p30': { label: '1080p · 30 fps', width: 1920, height: 1080, frameRate: 30, bitrate: 6000000 },
  '1080p60': { label: '1080p · 60 fps', width: 1920, height: 1080, frameRate: 60, bitrate: 8000000 },
  '1440p30': { label: '1440p · 30 fps', width: 2560, height: 1440, frameRate: 30, bitrate: 9000000 },
  kaynak: { label: 'Orijinal (ekran çözünürlüğü)', width: 3840, height: 2160, frameRate: 30, bitrate: 12000000, native: true }
};
const SHARE_QUALITY_DEFAULT = '1080p30';

// Capture card (HDMI/USB video aygiti) icin ek on ayar: konsol icerigi 60 fps
// ister, ama 4K yayin cok agir. 1080p60 yeterli; isteyen "Orijinal"i secer.
const CARD_QUALITIES = {
  '720p60': { label: '720p · 60 fps', width: 1280, height: 720, frameRate: 60, bitrate: 4000000 },
  '1080p30': { label: '1080p · 30 fps', width: 1920, height: 1080, frameRate: 30, bitrate: 6000000 },
  '1080p60': { label: '1080p · 60 fps', width: 1920, height: 1080, frameRate: 60, bitrate: 8000000 }
};
const CARD_QUALITY_DEFAULT = '1080p60';

// VP8 metin/arayuz iceriginde yumusak kaliyor; VP9 ayni bit hizinda belirgin
// sekilde daha keskin. VP8 eski cihazlar icin secenek olarak durur.
const SHARE_CODECS = {
  vp9: { label: 'VP9 (daha keskin)' },
  vp8: { label: 'VP8 (en uyumlu)' }
};
const SHARE_CODEC_DEFAULT = 'vp9';

// Ekran paylasiminin sesi. 'sistem' = tarayici penceresindeki ses kutusu,
// 'yok' = ses gonderilmez, 'aygit:<id>' = secilen ses girisi (Stereo Mix, sanal
// kablo vb.) dogrudan yakalanir.
const SHARE_AUDIO_DEFAULT = 'sistem';

// Ekran SESI icin ayri profil. Varsayilan audioPreset konusma icin 16 kbps ve
// dtx acik; film/muzik sesini bu ayarla gondermek kesik kesik ve bozuk bir
// sonuc verir. Bu yuzden ekran paylasiminda daha yuksek bit hizi ve dtx kapali
// kullanilir.
const SCREEN_AUDIO_BITRATE = 128000;

// --- Kamera ----------------------------------------------------------------
// Kamera acilirken kullanicinin sectigi kalite. Cozunurlukler IDEAL olarak
// verilir: tarayici kameranin destekledigi en yakin degeri secer. Boylece zayif
// bir kamerada "tam kalite" secildiginde kamera hic acilmaz duruma gelmez,
// yalnizca kameranin izin verdigi kadar yuksek cozunurluk alinir.
const CAMERA_QUALITIES = {
  tam: { label: 'Tam kalite (1080p)', width: 1920, height: 1080, frameRate: 30, bitrate: 2500000 },
  yarim: { label: 'Yarı kalite (720p)', width: 1280, height: 720, frameRate: 30, bitrate: 1200000 },
  ceyrek: { label: 'Çeyrek kalite (360p)', width: 640, height: 360, frameRate: 24, bitrate: 400000 }
};
const CAMERA_QUALITY_DEFAULT = 'tam';

let cameraQuality = CAMERA_QUALITY_DEFAULT;
// Kalite degisimi surerken yeni istekler bekletilir; restartTrack cagrilari
// birbirine girmesin diye (hizli ardisik degisimde kamera bozuluyordu).
let cameraQualityChanging = false;
// Degisim surerken gelen en son kalite istegi; istek bitince uygulanir.
let cameraQualityPending = null;
// Flaş yalnizca bazi (genelde arka) kameralarda vardir; durum burada tutulur.
let torchOn = false;

function camPreset() {
  return CAMERA_QUALITIES[cameraQuality] || CAMERA_QUALITIES[CAMERA_QUALITY_DEFAULT];
}

export function getCameraSettings() {
  return {
    quality: cameraQuality,
    qualities: Object.entries(CAMERA_QUALITIES).map(([key, value]) => ({ key, label: value.label }))
  };
}

let shareQuality = SHARE_QUALITY_DEFAULT;
let shareCodec = SHARE_CODEC_DEFAULT;
let shareAudioSource = SHARE_AUDIO_DEFAULT;
// Capture card paylasiminda ayri durum: hangi kart acik, hangi ses aygiti.
let cardQuality = CARD_QUALITY_DEFAULT;
let cardCodec = SHARE_CODEC_DEFAULT;
let cardAudioSource = SHARE_AUDIO_DEFAULT;
let cardPublishing = false;
let cardTrack = null;
let cardAudioTrack = null;
// Ayri bir ses aygiti secildiginde yakalanan iz; paylasim bitince durdurulur.
let shareAudioTrack = null;

/// Telefonda ekran paylasimi acikken telefonu yatay konuma kilitler. Ekran
/// paylasiminin dogal yonu yatay oldugu icin hem paylasan hem izleyen icin
/// goruntu daha dolu olur. Tarayici/cihaz desteklemiyorsa sessizce basarisiz
/// olur: kullanici telefonu elle dondurebilir.
async function ekraniYatayKilitle() {
  try {
    const o = screen.orientation;
    if (o && typeof o.lock === 'function') {
      await o.lock('landscape');
    }
  } catch {}
}

/// Ekran paylasimi kapaninca kilidi birakir; telefon normal konumuna doner.
function kilidiBirak() {
  try {
    const o = screen.orientation;
    if (o && typeof o.unlock === 'function') {
      o.unlock();
    }
  } catch {}
}

function sharePreset() {
  return SHARE_QUALITIES[shareQuality] || SHARE_QUALITIES[SHARE_QUALITY_DEFAULT];
}

// Simulcast katmanlari (q/h/f) burada KULLANILMAZ. Olcum: yayin 3 katmanli
// oldugunda SFU izleyiciye her zaman EN ALT katmani (640x360) gonderiyordu;
// izleyici 1080p istese bile goruntu 360p gelip kutuya geriliyor, bu da
// "bulanik" olarak goruluyordu. Tek katmanli yayinda secim yoktur: herkes
// secilen on ayarin cozunurlugunu alir. Karsiligi, banti zayif izleyici icin
// otomatik alt katmana inme ozelliginin olmamasi; onun yerine kullanici
// arayuzden daha dusuk bir on ayar secer.

export function getShareSettings() {
  return {
    quality: shareQuality,
    codec: shareCodec,
    audioSource: shareAudioSource,
    qualities: Object.entries(SHARE_QUALITIES).map(([key, value]) => ({ key, label: value.label })),
    codecs: Object.entries(SHARE_CODECS).map(([key, value]) => ({ key, label: value.label }))
  };
}

let lib = null;
let room = null;
let channelId = null;
let send = null;
let onState = () => {};
let onError = () => {};
let pendingTracks = new Map();
let reconnecting = false;

// ON-ARKA KAMERA: mobilde varsayilan on kamera. Cevirme islemi restartTrack ile
// yapilir; yayin kesilmeden yeni kamera ile devam eder.
let facing = 'user';
let camDeviceId = null;

// SES SEVIYESI: kullanici basina 0..2 (0 = sessiz, 1 = normal, 2 = guclendirilmis).
// 1'in uzerindeki degerler Web Audio GainNode gerektirir; element varsayilan olarak
// LiveKit'in kendi ses seviyesiyle (0..1) calisir.
const volumes = new Map();
const gains = new Map();
// Ekran paylasimi sesinin kisi basina seviyesi (izleyen icin, 0..2).
const screenVolumes = new Map();
let audioCtx = null;

const isTouch = typeof window !== 'undefined' &&
  (window.matchMedia?.('(pointer: coarse)')?.matches || 'ontouchstart' in window);

// Mobilde varsayilan kamera kalitesi 720p. 1080p dikey yayin yuklemede yaklasik
// iki kat veri harcar (olculdu: ~1.7 Mbps / ~1.3 Mbps). Kalici bir secimdir:
// kullanici arayuzden tek dokunusla "Tam kalite"ye alabilir.
if (isTouch) cameraQuality = 'yarim';

// Cihazda bulunan kamera sayisi: on/arka cevirme dugmesi buna gore gosterilir.
let cameraCount = 0;

// SES SEVIYESI 1'IN UZERI (guclendirme) Web Audio gerektirir; ses cikisi
// AudioContext uzerinden yonlendirilir. Android'de tarayici cikis cihazi secmeye
// izin vermez (setSinkId yoktur), bu yuzden boyle bir yonlendirme kulaklik takili
// olsa bile sesin telefon hoparlorunden cikmasina yol acabiliyor. Bu nedenle
// guclendirme YALNIZCA cikis cihazinin secilebildigi tarayicilarda acilir; diger
// tum durumlarda ses medya elementi uzerinden dogrudan calinir ve isletim
// sisteminin kulaklik/hoparlor yonlendirmesine uyar.
const boostSupported = typeof HTMLMediaElement !== 'undefined' &&
  'setSinkId' in HTMLMediaElement.prototype;
export const maxVolume = boostSupported ? 2 : 1;

async function loadLib() {
  if (lib) return lib;
  if (!window.LivekitClient) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/vendor/livekit-client.js';
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('LiveKit kütüphanesi yüklenemedi'));
      document.head.append(script);
    });
  }
  lib = window.LivekitClient;
  if (!lib) throw new Error('LiveKit kütüphanesi yüklenemedi');
  return lib;
}

function emit(patch) {
  onState(patch);
}

export async function join(options) {
  const LK = await loadLib();
  channelId = options.channelId;
  send = options.send;
  onState = options.onState || (() => {});
  onError = options.onError || (() => {});

  const res = await fetch(`/api/channels/${channelId}/voice-token`, {
    method: 'POST',
    credentials: 'same-origin'
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'token_alinamadi');

  const { Room, RoomEvent, Track } = LK;

  room = new Room({
    // adaptiveStream KAPALI. Acikken istemci, kutunun ekrandaki boyutuna gore
    // hangi katmani indirecegine karar veriyor. Ekran paylasimi kutusu (16:9
    // olsa bile) genelde ekranin yalnizca bir kismini kapladigi icin istemci
    // surekli ALT katmani (360p) seciyor, goruntu kutuya gerilerek belirgin
    // sekilde bulanik gorunuyordu. Olculdu: kutu 966x543 iken alinan goruntu
    // 640x360 idi. Kapaliyken istemci her zaman en yuksek katmani ister;
    // paylasilan ekran 1080p olarak gelir. Karsiligi daha fazla bant genisligi
    // (ev aginda sorun degil). Kullanilmayan alt katmanlar dynacast ile
    // duraklatildigi icin yayincinin yuklemesi bosa gitmez.
    adaptiveStream: false,
    dynacast: true,
    disconnectOnPageLeave: false,
    audioCaptureDefaults: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1
    },
    videoCaptureDefaults: {
      resolution: { width: camPreset().width, height: camPreset().height },
      frameRate: camPreset().frameRate,
      ...(isTouch ? { facingMode: facing } : {})
    },
    publishDefaults: {
      dtx: true,
      red: true,
      // Kamera da TEK katmanli yayinlanir. Cok katmanli yayinda SFU izleyiciye
      // en alt katmani (360p) gonderiyordu; kullanici "tam kalite" secse bile
      // goruntu 360p geliyordu (ekran paylasiminda da ayni sorun olculmustu).
      // Tek katmanda secim yoktur: kullanicinin sectigi kalite neyse o gonderilir.
      // Yukleme yalnizca bir kez yapilir; kac kisi izlerse izlesin yayincinin
      // yuklemesi artmaz (SFU dagitir). Bant tasarrufu isteyen kisi arayuzden
      // daha dusuk kalite secer.
      simulcast: false,
      videoCodec: 'vp8',
      videoEncoding: {
        maxBitrate: camPreset().bitrate,
        maxFramerate: camPreset().frameRate
      },
      screenShareEncoding: {
        maxBitrate: sharePreset().bitrate,
        maxFramerate: sharePreset().frameRate
      },
      audioPreset: { maxBitrate: AUDIO_MAX_BITRATE }
    }
  });

  room
    .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      registerTrack(track, publication, participant, Track);
    })
    .on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      dropTrack(participant.identity, publication?.source, Track);
    })
    .on(RoomEvent.LocalTrackPublished, (publication) => {
      const source = publication.source;
      // Kendi kamera/ekran yayinimizi da ayni kayit akisindan geciririz; boylece
      // yerel goruntu de kutuya baglanir. Mikrofon ATLANIR: kendi sesimizi
      // dinlemek yanki olusturur.
      if (publication.track && (source === Track.Source.Camera || source === Track.Source.ScreenShare)) {
        registerTrack(publication.track, publication, room.localParticipant, Track);
      }
      if (source === Track.Source.ScreenShare) emit({ screen: true });
      if (source === Track.Source.Camera) {
        emit({ cam: true });
        refreshCameraCount();
      }
    })
    .on(RoomEvent.LocalTrackUnpublished, (publication) => {
      dropTrack(room.localParticipant.identity, publication.source, Track);
      // Tarayici cubugundan "paylasimi durdur" denildiginde de ayri ses
      // aygitini serbest birak.
      if (publication.source === Track.Source.ScreenShare) {
        stopShareDeviceAudio();
        if (cardPublishing) stopCardTracks();
        emit({ screen: false });
      }
      if (publication.source === Track.Source.Camera) emit({ cam: false });
    })
    .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      emit({ activeSpeakers: speakers.map((s) => s.identity) });
    })
    .on(RoomEvent.ParticipantConnected, () => syncVoiceState())
    .on(RoomEvent.ParticipantDisconnected, (participant) => {
      pendingTracks.delete(String(participant.identity));
      pubs.delete(String(participant.identity));
      syncVoiceState();
    })
    .on(RoomEvent.Reconnecting, () => {
      reconnecting = true;
      onError('Bağlantı zayıf, yeniden bağlanılıyor…');
    })
    .on(RoomEvent.Reconnected, () => {
      reconnecting = false;
      syncVoiceState();
    })
    .on(RoomEvent.Disconnected, () => {
      reconnecting = false;
      emit({ channelId: null, mic: false, cam: false, screen: false, torch: false });
    })
    .on(RoomEvent.AudioPlaybackStatusChanged, () => {
      // Tarayici ses oynatimi engellediyse arayuz "dokun ve baslat" gosterir.
      emit({ needsTapForAudio: Boolean(room && !room.canPlaybackAudio) });
    })
    .on(RoomEvent.ActiveDeviceChanged, () => {
      // Cihaz degisimi (tarayici veya baska bir sekme tarafindan) arayuze bildirilir.
      emit({ deviceChangedAt: Date.now() });
    });

  await room.connect(data.url || location.origin, data.token);

  try {
    await room.startAudio();
  } catch {}

  await room.localParticipant.setMicrophoneEnabled(true, {
    echoCancellation: true,
    noiseSuppression: gurultuEngelle,
    autoGainControl: true,
    channelCount: 1
  });

  emit({ channelId, room, mic: true, cam: false, screen: false, facing, cameraQuality, torch: false });
  send?.({ op: 'voice_join', channelId, muted: false, video: false, screen: false });

  syncVoiceState();
  refreshCameraCount();

  // Arka planda ses kesilmesin: ekran uyanik tutulur, sekme medya olarak
  // bildirilir ve gorunurluk degisimleri dinlenir.
  bindVisibility();
  updateMediaSession(true);
  requestWakeLock();
  // Yerel uygulamada on plan servisi baslatilir: surec oldiirulmez ve ekran
  // kapaliyken de mikrofon/ses calismaya devam eder.
  if (yerelUygulama()) {
    try {
      window.SohbetNative.cagriBaslat();
      emit({ native: true, serviceRunning: true });
    } catch {}
  }
  emit({ needsTapForAudio: Boolean(!room.canPlaybackAudio) });

  return room;
}

/// Bir katilimcinin belirli bir kaynaga (kamera/ekran/mikrofon) ait yayinini bulur.
/// SDK surumleri arasinda kucuk farklar oldugu icin iki yol da denenir.
function pubFor(participant, source) {
  try {
    const pub = participant?.getTrackPublication?.(source);
    if (pub) return pub;
  } catch {}
  try {
    for (const pub of participant?.trackPublications?.values?.() || []) {
      if (pub?.source === source) return pub;
    }
  } catch {}
  return null;
}

// Uzak video yayinlarinin nesneleri: gorunmeyen kutularin yayinini askiya almak
// (veri tasarrufu) icin saklanir. Kamera ve ekran paylasimi ayri tutulur.
const pubs = new Map();

/// Yalnizca listedeki kullanicilarin KAMERA yayini indirilir; digerleri askiya
/// alinir. `null` verilirse tum kameralar acilir. Ekran paylasimi yayinlari ve
/// tum sesler etkilenmez: yalnizca ekranda gorunmeyen goruntu indirilmez.
/// setEnabled, durum HIC degismese bile ilk cagrida sunucuya track guncellemesi
/// gonderip yayini yeniden baslatiyor; tam ekranda gorunen kameraya bu cagri
/// gittiginde goruntu donuyordu. Bu yuzden son uygulanan durum nesneyle birlikte
/// izlenir ve setEnabled yalnizca GERCEKTEN degisiyorsa cagrilir.
const camState = new Map();

export function setVisibleCameras(keys) {
  const izinli = keys == null ? null : new Set(Array.from(keys, String));
  for (const [key, p] of pubs) {
    const pub = p.camera;
    if (!pub || pub.isLocal) continue;
    const acik = izinli == null || izinli.has(key);
    // Yayinin GERCEK durumu: requestedDisabled henuz hic ayarlanmadiysa kamera
    // iniyor demektir (varsayilan acik). Durum istenenle ayniysa setEnabled
    // HIC cagrilmaz; cagrilirsa sunucuya track guncellemesi gidip yayin
    // yeniden baslar ve goruntu anlik donar.
    const simdiAcik = pub.requestedDisabled !== true;
    const oncek = camState.get(key);
    if (oncek && oncek.pub !== pub) camState.delete(key);
    if (simdiAcik === acik) { camState.set(key, { pub, acik }); continue; }
    camState.set(key, { pub, acik });
    try { pub.setEnabled(acik); } catch { camState.delete(key); }
  }
}

function registerTrack(track, publication, participant, Track) {
  const key = String(participant.identity);
  const entry = pendingTracks.get(key) || {};
  const source = publication?.source;
  if (source === Track.Source.Camera || source === Track.Source.ScreenShare) {
    const p = pubs.get(key) || {};
    if (source === Track.Source.Camera) p.camera = publication;
    else p.screen = publication;
    pubs.set(key, p);
  }

  if (source === Track.Source.ScreenShare) entry.screen = track;
  else if (source === Track.Source.Camera) entry.camera = track;
  else if (track.kind === 'audio') {
    // Bir katilimcinin birden fazla ses yayini olabilir: mikrofon ve (varsa)
    // ekran paylasimi sesi. Oncekileri ezmemek icin liste halinde tutulur.
    if (!entry.audios) entry.audios = [];
    const kind = source === Track.Source.ScreenShareAudio ? 'screen' : 'mic';
    if (!entry.audios.some((slot) => slot.track === track)) {
      const slot = { track, el: null, kind };
      if (kind === 'mic') entry.audios.unshift(slot);
      else entry.audios.push(slot);
    }
  }

  pendingTracks.set(key, entry);

  if (track.kind === 'audio') {
    attachAudioElements(key);
    attachTracks();
  }
  syncVoiceState();
}

/// Ses yayinlari icin (gorunmez) ses elementlerini olusturur ve kayitli ses
/// seviyesini uygular. Var olan elementler yeniden kullanilir.
function attachAudioElements(key) {
  const entry = pendingTracks.get(key);
  if (!entry?.audios?.length) return;
  for (const slot of entry.audios) {
    if (slot.el && slot.el.isConnected) continue;
    try {
      const node = slot.track.attach();
      node.autoplay = true;
      node.style.display = 'none';
      node.dataset.peer = key;
      node.muted = deafened;
      document.body.append(node);
      slot.el = node;
    } catch {}
  }
  applyVolume(key);
}

function applyVolume(key) {
  const entry = pendingTracks.get(key);
  if (!entry?.audios?.length) return;
  const kisi = volumes.has(key) ? volumes.get(key) : 1;
  // Ekran paylasimi sesi ayri bir seviyeden kontrol edilir (izleyen icin).
  const ekran = screenVolumes.has(key) ? screenVolumes.get(key) : 1;
  for (const slot of entry.audios) {
    applyVolumeTo(slot, slot.kind === 'mic' ? kisi : ekran);
  }
}

/// Tek bir ses yayinina seviye uygular. 1 ve altindaki degerler LiveKit'in kendi
/// ses seviyesiyle verilir (tum tarayicilarda guvenli). 1'in uzerindeki deger
/// gercek guclendirme gerektirir; bu yuzden ses elementi Web Audio GainNode
/// uzerinden gecirilir.
function applyVolumeTo(slot, value) {
  if (!slot?.track) return;
  // Guclendirme desteklenmiyorsa seviye en fazla 1'de kalir (ses yonlendirmesi
  // bozulmasin diye medya elementi dogrudan calinir).
  const target = Math.max(0, Math.min(maxVolume, value));
  const existing = gains.get(slot.track);

  if (target <= 1) {
    if (existing) {
      try { slot.el.volume = 1; } catch {}
      existing.gain.value = target;
    } else {
      try { slot.track.setVolume(target); } catch {}
    }
    return;
  }

  if (existing) {
    existing.gain.value = target;
    return;
  }

  const ctx = ensureAudioCtx();
  if (!ctx || !slot.el) {
    try { slot.track.setVolume(1); } catch {}
    return;
  }
  try {
    const source = ctx.createMediaElementSource(slot.el);
    const gain = ctx.createGain();
    source.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.value = target;
    gains.set(slot.track, gain);
    slot.el.volume = 1;
  } catch {
    try { slot.track.setVolume(1); } catch {}
  }
}

// NOT: Kulaklık takıldığında ses yönlendirmesi tarayıcı/işletim sistemi tarafından
// yapılır. Android'de tarayıcının çıkış cihazını seçme yetkisi yoktur (setSinkId
// yoktur), bu yüzden web tarafından zorlanamaz. Yapılabilecek tek şey sesin
// yönlendirmeyi bozabilecek Web Audio yolundan geçmemesini sağlamaktır; bunu
// yukarıdaki maxVolume/boostSupported kuralı yapar.

function ensureAudioCtx() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) {
    try { audioCtx = new Ctx(); } catch { return null; }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

/// Tarayici otomatik oynatma kurallari AudioContext'i askiya alabilir; her
/// kullanici dokunusunda tekrar acilir. ONEMLI: burada yeni bir AudioContext
/// OLUSTURULMAZ. Bos bir AudioContext kulaklik yonlendirmesini etkileyebildigi
/// icin yalnizca zaten var olan (guclendirme kullanilmis) baglam devam ettirilir.
export function resumeAudio() {
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
}

/* ==================== ARKA PLANDA SES ====================
  Telefonda ekran kapaninca ya da uygulama arka plana atilinca tarayici sekmeyi
  askiya alir ve ses kesilir. Uc ayri onlem alinir:

  1) EKRAN UYANIK TUTMA (Wake Lock): Sesli kanaldayken ekranin kendiliginden
     kapanmasi engellenir. Kullanici guc dugmesiyle ekrani elle kapatirsa
     tarayici kilidi serbest birakir; bu durumda ses yine devam eder (madde 2-3)
     ama isletim sistemi garantisi yoktur.
  2) AUDIO CONTEXT: Sayfa tekrar gorunur oldugunda hem AudioContext hem de
     LiveKit'in ses oynatimi yeniden acilir.
  3) MEDIA SESSION: Sayfa "medya caliyor" olarak bildirilir; tarayici sekmeyi
     arka planda dondurmaz ve kilit ekraninda kontrol gorunur.
  Ayrica LiveKit'in sayfadan ayrilinca baglantiyi kesme davranisi zaten kapali
  (disconnectOnPageLeave: false). */

let wakeLock = null;
let visBound = false;

/// Sayfa yerel Android uygulamasi icinde mi calisiyor? Uygulama, WebView'e
/// "SohbetNative" adli bir kopru nesnesi ekler.
function yerelUygulama() {
  try {
    return typeof window !== 'undefined' && Boolean(window.SohbetNative?.yerelUygulama?.());
  } catch {
    return false;
  }
}

/// Ekranin kendiliginden kapanmasini engeller (destekleyen tarayicilarda).
export async function requestWakeLock() {
  if (!room) return false;
  // Yerel uygulamada on plan servisi ekran/uyku yonetimini zaten ustlenir.
  // Web ekran kilidi burada gereksiz VE ZARARLI olurdu: ekrani acik tutar,
  // oysa amac ekran kapaliyken de sesin surmesidir.
  if (yerelUygulama()) {
    emit({ wakeLock: false, wakeLockSupported: false, native: true });
    return false;
  }
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) {
    emit({ wakeLock: false, wakeLockSupported: false });
    return false;
  }
  if (wakeLock && !wakeLock.released) return true;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
      emit({ wakeLock: false });
    });
    emit({ wakeLock: true, wakeLockSupported: true });
    return true;
  } catch {
    // Kullanici izni yok veya sekme arka planda; gorunur olunca tekrar denenir.
    emit({ wakeLock: false, wakeLockSupported: true });
    return false;
  }
}

export function releaseWakeLock() {
  if (wakeLock) {
    try { wakeLock.release(); } catch {}
  }
  wakeLock = null;
  emit({ wakeLock: false });
}

/// Sekmenin arka planda dondurulmamasi icin "medya caliyor" bildirimi.
function updateMediaSession(active) {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  try {
    if (active) {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: 'Sesli sohbet',
        artist: 'Sohbet',
        album: 'Sohbet'
      });
      navigator.mediaSession.playbackState = 'playing';
    } else {
      navigator.mediaSession.playbackState = 'none';
      navigator.mediaSession.metadata = null;
    }
  } catch {}
}

/// Sayfa tekrar gorunur oldugunda sesi geri getirir. Tarayici geri planda
/// AudioContext'i askiya alir ve LiveKit'in oynatimi durabilir; ikisi de
/// burada yeniden acilir.
async function reviveAudio() {
  resumeAudio();
  if (!room) return;
  try {
    if (!room.canPlaybackAudio) await room.startAudio();
  } catch {}
  emit({ needsTapForAudio: Boolean(room && !room.canPlaybackAudio) });
}

/// Kullanici dokundugunda sesi baslatir (tarayici otomatik oynatmayi engellediyse).
export async function startAudioIfNeeded() {
  if (!room) return false;
  try {
    await room.startAudio();
  } catch {}
  resumeAudio();
  const ok = Boolean(room.canPlaybackAudio);
  emit({ needsTapForAudio: !ok });
  return ok;
}

function bindVisibility() {
  if (visBound || typeof document === 'undefined') return;
  visBound = true;
  document.addEventListener('visibilitychange', () => {
    if (!room) return;
    if (document.visibilityState === 'visible') {
      reviveAudio();
      requestWakeLock();
    }
  });
  // Tarayici ses oynatimi engellerse (otomatik oynatma kurali) kullaniciya
  // dokunmasi gerektigi bildirilir.
  if (typeof window !== 'undefined') {
    window.addEventListener('pageshow', () => { if (room) reviveAudio(); });
  }
}

/// Bir katilimcinin ses seviyesini ayarlar (0..2).
export function setRemoteVolume(userId, value) {
  const key = String(userId);
  const clamped = Math.max(0, Math.min(2, Number(value) || 0));
  volumes.set(key, clamped);
  applyVolume(key);
  return clamped;
}

export function getRemoteVolume(userId) {
  const key = String(userId);
  return volumes.has(key) ? volumes.get(key) : 1;
}

/// Bir katilimcinin ekran paylasimi sesini ayarlar (0..2). Yalnizca izleyenin
/// tarayicisinda gecerlidir; konusmacinin yayinina dokunmaz.
export function setScreenVolume(userId, value) {
  const key = String(userId);
  const clamped = Math.max(0, Math.min(2, Number(value) || 0));
  screenVolumes.set(key, clamped);
  applyVolume(key);
  return clamped;
}

export function getScreenVolume(userId) {
  const key = String(userId);
  return screenVolumes.has(key) ? screenVolumes.get(key) : 1;
}

function detachTrack(track) {
  try { track.detach().forEach((node) => node.remove()); } catch {}
}

function removeSlot(slot) {
  detachTrack(slot?.track);
  try { slot?.el?.remove(); } catch {}
  const gain = gains.get(slot?.track);
  if (gain) {
    try { gain.disconnect(); } catch {}
    gains.delete(slot.track);
  }
}

function dropTrack(identity, source, Track) {
  const key = String(identity);
  const entry = pendingTracks.get(key);
  const yayinlar = pubs.get(key);
  if (yayinlar) {
    if (source === Track.Source.Camera) { delete yayinlar.camera; camState.delete(key); }
    else if (source === Track.Source.ScreenShare) delete yayinlar.screen;
  }
  if (!entry) return;
  if (source === Track.Source.ScreenShare) {
    if (entry.screen) { detachTrack(entry.screen); delete entry.screen; }
  } else if (source === Track.Source.Camera) {
    if (entry.camera) { detachTrack(entry.camera); delete entry.camera; }
  } else if (entry.audios?.length) {
    const kind = source === Track.Source.ScreenShareAudio ? 'screen' : 'mic';
    const keep = [];
    for (const slot of entry.audios) {
      if (slot.kind === kind) removeSlot(slot);
      else keep.push(slot);
    }
    entry.audios = keep;
    attachAudioElements(key);
  }
  attachTracks();
  syncVoiceState();
}

/// Video yuvalarini doldurur. Var olan <video> elementi YENIDEN KULLANILIR.
/// Her cagride yeni element uretmek, her durum degisiminde videoyu bastan
/// cozmeye zorluyor; mobilde bellegi sisirip sekmeyi cokertiyor ve goruntunun
/// surekli yanip sonmesine (blink) yol aciyordu.
export function attachTracks() {
  if (!room) return;
  const put = (tileId, track) => {
    const tile = document.getElementById(tileId);
    if (!tile || !track) return;
    let node = tile.querySelector('video');
    if (node && track.attachedElements?.includes?.(node)) return;
    try {
      node = track.attach(node || undefined);
    } catch {
      return;
    }
    // Ses ayri yayin olarak calinir; video elementi sessiz kalmali (yanki olmasin).
    node.playsInline = true;
    node.autoplay = true;
    node.muted = true;
    if (!node.parentElement) tile.prepend(node);
  };
  for (const [key, entry] of pendingTracks) {
    if (entry.camera) put(`tile-cam-${key}`, entry.camera);
    if (entry.screen) put(`tile-screen-${key}`, entry.screen);
  }
}

/// Ekran paylasimi tam ekrandayken sag ustte gorunen kucuk kamera penceresi
/// (PIP). Secilen kullanicinin kamera yayini bu kutuya baglanir; ayni yayin
/// normal kutusunda da akmaya devam eder (LiveKit ayni track'i birden fazla
/// elemente baglayabilir).
export function attachPip(userId) {
  const key = String(userId);
  const entry = pendingTracks.get(key);
  const track = entry?.camera;
  const pip = document.getElementById('pip-cam');
  if (!pip || !track) return;
  let node = pip.querySelector('video');
  if (node && track.attachedElements?.includes?.(node)) return;
  try {
    node = track.attach(node || undefined);
  } catch {
    return;
  }
  node.playsInline = true;
  node.autoplay = true;
  node.muted = true;
  if (!node.parentElement) pip.prepend(node);
}

/// PIP kutusundaki videoyu kaldirir (yayin durmaz, yalnizca baglanti kesilir).
export function detachPip() {
  const pip = document.getElementById('pip-cam');
  if (!pip) return;
  const node = pip.querySelector('video');
  if (node) {
    try { node.srcObject = null; } catch {}
    node.remove();
  }
}

function syncVoiceState() {
  if (!room) return;
  const users = [];
  const local = room.localParticipant;
  if (local) {
    users.push({
      userId: Number(local.identity),
      muted: !local.isMicrophoneEnabled,
      video: local.isCameraEnabled,
      screen: local.isScreenShareEnabled
    });
  }
  for (const participant of room.remoteParticipants.values()) {
    users.push({
      userId: Number(participant.identity),
      muted: !participant.isMicrophoneEnabled,
      video: participant.isCameraEnabled,
      screen: participant.isScreenShareEnabled
    });
  }
  send?.({ op: 'voice_join', channelId, muted: !local?.isMicrophoneEnabled, video: Boolean(local?.isCameraEnabled), screen: Boolean(local?.isScreenShareEnabled) });
  send?.({ op: 'voice_update', channelId, muted: !local?.isMicrophoneEnabled, video: Boolean(local?.isCameraEnabled), screen: Boolean(local?.isScreenShareEnabled) });
}

// SAGIRLASTIRMA (deafen): mikrofon kapatilir VE uzak sesler (tum cihazlardan
// gelen yayinlar) susdurulur. Konusma modlari (bas konus / ses algilama) sagir
// durumda mikrofonu acamaz. Konusma modu yokken sagirlik kaldirilinca mikrofon
// eski haline doner.
let deafened = false;
let micBeforeDeafen = false;

export function isDeafened() {
  return deafened;
}

/// Sagirlastirmayi acar/kapatir. Acildiginda mikrofon kapanir, gelen tum ses
/// susdurulur; kapatildiginda gelen ses geri gelir ve (konusma modu yoksa)
/// mikrofon sagirlik oncesi durumuna doner.
export async function setDeafened(enabled) {
  if (!room) return false;
  const next = Boolean(enabled);
  if (deafened === next) return deafened;
  deafened = next;

  if (deafened) {
    micBeforeDeafen = Boolean(room.localParticipant.isMicrophoneEnabled);
    if (vadEnabled) {
      // Ses algilama mikrofonu sessiz tutuyor olabilir; yayin acik kalmasin.
      vadOpen = false;
      vadSonSes = 0;
    }
    pttHolding = false;
    if (room.localParticipant.isMicrophoneEnabled) {
      try {
        await room.localParticipant.setMicrophoneEnabled(false);
      } catch {}
    }
    emit({ mic: false });
    send?.({ op: 'voice_update', channelId, muted: true });
  } else {
    // Konusma modu aciksa mikrofonu mod yonetir; dokunulmaz.
    if (!pttEnabled && !vadEnabled && micBeforeDeafen) {
      try {
        await room.localParticipant.setMicrophoneEnabled(true, {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        });
        emit({ mic: true });
        send?.({ op: 'voice_update', channelId, muted: false });
      } catch {}
    }
  }

  uygulaSagirlik();
  emit({ sagir: deafened });
  return deafened;
}

/// Uzak ses elementlerinin tamamina sagirlik durumunu uygular. Yeni katilan
/// kisilerin yayinlari da (attachAudioElements icinden) ayni kurala uyar.
/// Guclendirme (GainNode) yolundan gecen yayinlarda ses elementi seviyesine
/// ek olarak gain sifirlanir; sagirlik kalkinca kayitli seviyeler geri yuklenir.
function uygulaSagirlik() {
  document.querySelectorAll('audio[data-peer]').forEach((node) => {
    try {
      node.muted = deafened;
    } catch {}
  });
  for (const gain of gains.values()) {
    try {
      gain.gain.value = deafened ? 0 : 1;
    } catch {}
  }
  if (!deafened) {
    for (const key of pendingTracks.keys()) applyVolume(key);
  }
}

// BAS KONUS (push-to-talk): mikrofon yalnizca secilen tus basili tutulurken
// acilir. Yalnizca bilgisayarda anlamlidir (klavye gerekir).
let pttEnabled = false;
let pttHolding = false;

export function isPttEnabled() {
  return pttEnabled;
}

export async function toggleMic() {
  if (!room || deafened) return;
  // Elle mikrofon düğmesine basıldıysa bas konuş / ses algılama kapanır.
  if (pttEnabled || vadEnabled) {
    pttEnabled = false;
    pttHolding = false;
    vadEnabled = false;
    vadTemizle();
    emit({ ptt: false, vad: false });
  }
  const next = !room.localParticipant.isMicrophoneEnabled;
  try {
    await room.localParticipant.setMicrophoneEnabled(next, {
      echoCancellation: true,
      noiseSuppression: gurultuEngelle,
      autoGainControl: true,
      channelCount: 1
    });
    emit({ mic: next });
    send?.({ op: 'voice_update', channelId, muted: !next });
  } catch (error) {
    onError('Mikrofon değiştirilemedi: ' + (error.message || ''));
  }
}

let gurultuEngelle = true;

/// Gurultu engelleme acik/kapali. Tarayicinin yerlesik gurultu engelleme
/// (RNNoise) ozelligi mikrofon constraint'i ile acilir/kapatilir; mikrofon
/// yeniden baslatilir.
export async function setNoiseSuppression(enabled) {
  gurultuEngelle = Boolean(enabled);
  if (!room || !room.localParticipant.isMicrophoneEnabled) return gurultuEngelle;
  try {
    await room.localParticipant.setMicrophoneEnabled(false);
    await room.localParticipant.setMicrophoneEnabled(true, {
      echoCancellation: true,
      noiseSuppression: gurultuEngelle,
      autoGainControl: true,
      channelCount: 1
    });
    emit({ mic: true });
  } catch (error) {
    onError('Gürültü engelleme değiştirilemedi: ' + (error.message || ''));
  }
  return gurultuEngelle;
}

/// Bas konus modunu acar/kapatir. Acildiginda mikrofon kapanir; tus basili
/// tutuldukca acilir, birakilinca kapanir.
export async function setPttEnabled(enabled) {
  if (!room) return false;
  pttEnabled = Boolean(enabled);
  pttHolding = false;
  if (pttEnabled && room.localParticipant.isMicrophoneEnabled) {
    try {
      await room.localParticipant.setMicrophoneEnabled(false);
      emit({ mic: false, ptt: true });
      send?.({ op: 'voice_update', channelId, muted: true });
      return pttEnabled;
    } catch {}
  }
  emit({ ptt: pttEnabled });
  return pttEnabled;
}

/// Bas konus tusu basildi/birakildi. Yalnizca bas konus acikken etki eder.
export async function setPttHolding(holding) {
  if (!room || !pttEnabled) return false;
  // Sagir durumda tus basili tutulsa da mikrofon acilmaz.
  const next = Boolean(holding) && !deafened;
  if (pttHolding === next) return pttHolding;
  pttHolding = next;
  try {
    await room.localParticipant.setMicrophoneEnabled(next, {
      echoCancellation: true,
      noiseSuppression: gurultuEngelle,
      autoGainControl: true,
      channelCount: 1
    });
    emit({ mic: next });
    send?.({ op: 'voice_update', channelId, muted: !next });
  } catch (error) {
    onError('Mikrofon değiştirilemedi: ' + (error.message || ''));
  }
  return pttHolding;
}

// SES ALGILAMA (voice activity): mikrofon sürekli yayında kalır ama sessizken
// susturulur; sesin eşiği geçtiğinde kendiliğinden açılır. Klavye olayı
// gerekmediği için sekme arka plandayken (alt+tab) de çalışır.
let vadEnabled = false;
let vadOpen = false;
let vadEsik = 0.04;
let vadSonSes = 0;
let vadCtx = null;
let vadNode = null;
let vadSource = null;
let vadModulYuklu = false;

/// Yerel mikrofon yayinini bulur (susturma/acma icin).
function micPub() {
  if (!room || !lib) return null;
  try {
    return pubFor(room.localParticipant, lib.Track.Source.Microphone);
  } catch {
    return null;
  }
}

/// Yerel mikrofonu susturur/açar. Susturma yayini kapatmaz: yalnizca sessiz
/// veri gonderilir, boylece gecis aninda yeniden yayin kurulmaz (gecikme yok).
function vadMute(muted) {
  const pub = micPub();
  const track = pub?.track || pub?.audioTrack;
  try {
    if (pub && typeof pub.mute === 'function') {
      if (muted) pub.mute();
      else pub.unmute();
      return true;
    }
    if (track && typeof track.mute === 'function') {
      if (muted) track.mute();
      else track.unmute();
      return true;
    }
  } catch {}
  return false;
}

function vadDurumYaz(micAcik) {
  emit({ mic: micAcik, vad: true });
  send?.({ op: 'voice_update', channelId, muted: !micAcik });
}

function vadSeviye(rms) {
  if (!vadEnabled) return;
  const now = performance.now();
  if (rms >= vadEsik) {
    vadSonSes = now;
    if (!vadOpen) {
      // Sagir durumda ses algilama mikrofonu acamaz.
      if (deafened) return;
      // Sapma (histerezis): kapanma esigi acilma esiginden dusuktur; kelime
      // aralarinda mikrofonun surekli acilip kapanmasi onlenir.
      const cd = micPub();
      vadOpen = true;
      if (!vadMute(false) && cd) {
        room?.localParticipant?.setMicrophoneEnabled?.(true).catch(() => {});
      }
      vadDurumYaz(true);
    }
    return;
  }
  // Ses kesildikten ~400 ms sonra kapat (kelime aralari mikrofonu kapatmasin).
  if (vadOpen && now - vadSonSes > 400) {
    vadOpen = false;
    if (!vadMute(true)) {
      room?.localParticipant?.setMicrophoneEnabled?.(false).catch(() => {});
    }
    vadDurumYaz(false);
  }
}

/// Analiz grafigini kurar: mikrofon -> worklet -> sessiz cikis.
async function vadKur() {
  const pub = micPub();
  const track = pub?.track || pub?.audioTrack;
  if (!track) throw new Error('mikrofon yayında değil');
  if (!vadCtx) vadCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (vadCtx.state === 'suspended') await vadCtx.resume().catch(() => {});
  if (!vadModulYuklu) {
    await vadCtx.audioWorklet.addModule('/vad.js');
    vadModulYuklu = true;
  }
  vadSource = vadCtx.createMediaStreamSource(new MediaStream([track]));
  vadNode = new AudioWorkletNode(vadCtx, 'vad');
  // Cikis sessiz olmali: analiz grafigi kulakliga/yanitiya ses vermez.
  const sessiz = vadCtx.createGain();
  sessiz.gain.value = 0;
  vadSource.connect(vadNode);
  vadNode.connect(sessiz);
  sessiz.connect(vadCtx.destination);
  vadNode.port.onmessage = (event) => vadSeviye(Number(event.data) || 0);
}

function vadTemizle() {
  try { vadNode?.port?.close?.(); } catch {}
  try { vadNode?.disconnect?.(); } catch {}
  try { vadSource?.disconnect?.(); } catch {}
  vadNode = null;
  vadSource = null;
  vadOpen = false;
  vadSonSes = 0;
}

export function isVadEnabled() {
  return vadEnabled;
}

export function setVadThreshold(value) {
  const v = Number(value);
  if (Number.isFinite(v)) vadEsik = Math.max(0.002, Math.min(0.4, v));
  return vadEsik;
}

export function getVadThreshold() {
  return vadEsik;
}

/// Ses algilama modunu acar/kapatir. Acildiginda mikrofon yayina alinir ve
/// sessiz baslar; ses esigi gecildiginde kendiliginden acilir.
export async function setVadEnabled(enabled, threshold) {
  if (!room) return false;
  if (threshold !== undefined && threshold !== null) setVadThreshold(threshold);
  if (enabled) {
    // Bas konus ile ayni anda calismaz.
    pttEnabled = false;
    pttHolding = false;
    if (!room.localParticipant.isMicrophoneEnabled) {
      try {
        await room.localParticipant.setMicrophoneEnabled(true, {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        });
      } catch (error) {
        onError('Mikrofon açılamadı: ' + (error.message || ''));
        return false;
      }
    }
    try {
      await vadKur();
    } catch (error) {
      onError('Ses algılama başlatılamadı: ' + (error.message || ''));
      vadTemizle();
      return false;
    }
    vadEnabled = true;
    // Sessiz basla: esik gecilene kadar mikrofon kapali kalsin.
    vadOpen = false;
    vadSonSes = 0;
    if (!vadMute(true)) room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
    emit({ vad: true, ptt: false, mic: false });
    send?.({ op: 'voice_update', channelId, muted: true });
    return true;
  }
  vadEnabled = false;
  vadTemizle();
  if (deafened) {
    // Sagir durumda mikrofon acilmaz; yayin yine kapali kalir.
    if (!vadMute(true)) room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
    emit({ vad: false, mic: false });
    send?.({ op: 'voice_update', channelId, muted: true });
    return false;
  }
  // Modan cikinca mikrofon normal sekilde acik kalir.
  if (!vadMute(false)) room.localParticipant.setMicrophoneEnabled(true).catch(() => {});
  emit({ vad: false, mic: Boolean(micPub()?.track || micPub()?.audioTrack) });
  send?.({ op: 'voice_update', channelId, muted: false });
  return false;
}


export async function toggleCam() {
  if (!room) return;
  const next = !room.localParticipant.isCameraEnabled;
  try {
    if (next) {
      // Kamera acilirken secili kalite, secili cihaz / varsayilan yon uygulanir.
      const preset = camPreset();
      const options = {
        resolution: { width: preset.width, height: preset.height },
        frameRate: preset.frameRate
      };
      if (camDeviceId) options.deviceId = camDeviceId;
      else if (isTouch) options.facingMode = facing;
      await room.localParticipant.setCameraEnabled(true, options);
      torchOn = false;
    } else {
      await room.localParticipant.setCameraEnabled(false);
      // Kamera kapaninca flas da kapanir; bir sonraki acilista yanik kalmasin.
      torchOn = false;
    }
    emit({ cam: next, cameraQuality, torch: torchOn, torchAvailable: next && torchAvailable() });
    send?.({ op: 'voice_update', channelId, video: next });
  } catch (error) {
    onError('Kamera açılamadı: ' + (error.message || ''));
  }
}

/// Yerel kameranin ham medya izi (flas ve yetenek sorgulari icin).
function localCamMediaTrack() {
  if (!room || !lib) return null;
  const publication = pubFor(room.localParticipant, lib.Track.Source.Camera);
  const track = publication?.track || publication?.videoTrack;
  return track?.mediaStreamTrack || null;
}

/// Kamerada flas var mi? Yalnizca arka kamerada ve bazi cihazlarda bulunur.
export function torchAvailable() {
  const media = localCamMediaTrack();
  try {
    return Boolean(media?.getCapabilities?.().torch);
  } catch {
    return false;
  }
}

/// Kameranin flasini acar/kapatir. Tarayici destegi yoksa kullanici bilgilendirilir.
export async function toggleTorch() {
  const media = localCamMediaTrack();
  if (!media) {
    onError('Flaş için önce kamerayı aç');
    return false;
  }
  if (!torchAvailable()) {
    onError('Bu kamerada flaş yok (genelde yalnızca arka kamerada bulunur)');
    return false;
  }
  const next = !torchOn;
  try {
    // Flas standart bir kisit degil, "advanced" ile verilir; tarayici
    // desteklemiyorsa sessizce yok sayilir.
    await media.applyConstraints({ advanced: [{ torch: next }] });
    torchOn = next;
    emit({ torch: torchOn, torchAvailable: true });
    return torchOn;
  } catch (error) {
    onError('Flaş değiştirilemedi: ' + (error.message || ''));
    return torchOn;
  }
}

/// Kamera kalitesini degistirir. Kamera acikken yayin KESILMEDEN uygulanir:
/// iz yeniden baslatilir, ayni yayin yeni cozunurlukle devam eder. Hizli
/// ardisik degisimde restartTrack cagrilari birbirine girmesin diye surumdeki
/// istek bitmeden yenisi baslamaz; bu sirada gelen en son istek kuyruga alinir.
export async function setCameraQuality(key) {
  if (!CAMERA_QUALITIES[key]) return false;
  if (cameraQualityChanging) {
    cameraQualityPending = key;
    return true;
  }
  cameraQualityChanging = true;
  cameraQuality = key;
  const preset = CAMERA_QUALITIES[key];
  try {
    const publication = room ? pubFor(room.localParticipant, lib.Track.Source.Camera) : null;
    const track = publication?.track || publication?.videoTrack;
    if (!track || typeof track.restartTrack !== 'function') {
      // Kamera kapali: secim bir sonraki acilista uygulanir.
      return true;
    }

    const options = {
      resolution: { width: preset.width, height: preset.height },
      frameRate: preset.frameRate
    };
    if (camDeviceId) options.deviceId = { exact: camDeviceId };
    else if (isTouch) options.facingMode = facing;
    await track.restartTrack(options);
    await applyCamBitrate(preset.bitrate);
    // Iz yeniden baslatilinca flas soner.
    torchOn = false;
    emit({ cameraQuality: key, torch: false, torchAvailable: torchAvailable() });
    return true;
  } catch (error) {
    onError('Kamera kalitesi değiştirilemedi: ' + (error.message || ''));
    return false;
  } finally {
    cameraQualityChanging = false;
    const pending = cameraQualityPending;
    cameraQualityPending = null;
    if (pending && pending !== key) setCameraQuality(pending);
  }
}

/// Kamera yayininin bit hizini gunceller. Cozunurluk dusunce bit hizinin de
/// dusmesi gerekir; aksi halde kodlayici gereksiz bant harcar.
async function applyCamBitrate(bitrate) {
  const publication = room ? pubFor(room.localParticipant, lib.Track.Source.Camera) : null;
  const sender = publication?.track?.sender;
  if (!sender?.getParameters || !sender?.setParameters) return false;
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    for (const encoding of params.encodings) encoding.maxBitrate = bitrate;
    await sender.setParameters(params);
    return true;
  } catch {
    return false;
  }
}

/// Cihaz listesi. Izin verilmeden once etiketler bos gelebilir; sesli kanala
/// katildiktan sonra (mikrofon izni verildiginde) etiketler dolar.
export async function listDevices() {
  const empty = { mics: [], cams: [] };
  if (!navigator.mediaDevices?.enumerateDevices) return empty;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const label = (device, index, prefix) =>
      device.label || `${prefix} ${index + 1}`;
    let micIndex = 0;
    let camIndex = 0;
    return {
      mics: devices
        .filter((d) => d.kind === 'audioinput')
        .map((d) => ({ id: d.deviceId, label: label(d, micIndex++, 'Mikrofon') })),
      cams: devices
        .filter((d) => d.kind === 'videoinput')
        .map((d) => ({ id: d.deviceId, label: label(d, camIndex++, 'Kamera') }))
    };
  } catch {
    return empty;
  }
}

async function refreshCameraCount() {
  try {
    const { cams } = await listDevices();
    cameraCount = cams.length;
  } catch {
    cameraCount = 0;
  }
  emit({ cameraCount });
  return cameraCount;
}

/// Mikrofon cihazini degistirir.
export async function switchMicDevice(deviceId) {
  if (!room) return false;
  try {
    await room.switchActiveDevice('audioinput', deviceId);
    return true;
  } catch (error) {
    onError('Mikrofon değiştirilemedi: ' + (error.message || ''));
    return false;
  }
}

/// Kamera cihazini degistirir. Kamera kapaliysa secim saklanir ve kamera
/// acildiginda uygulanir.
export async function switchCamDevice(deviceId) {
  if (!room) {
    camDeviceId = deviceId;
    return true;
  }
  camDeviceId = deviceId;
  const publication = pubFor(room.localParticipant, lib.Track.Source.Camera);
  const track = publication?.track || publication?.videoTrack;
  if (!track || typeof track.restartTrack !== 'function') {
    // Kamera su an yayinda degil; secim bir sonraki acilista kullanilir.
    return true;
  }
  try {
    await track.restartTrack({ deviceId: { exact: deviceId } });
    // Cihaz degisince flas yetenegi ve durumu degisir; cihaz degistirmek
    // flasi sondurur.
    torchOn = false;
    emit({ torch: false, torchAvailable: torchAvailable() });
    return true;
  } catch (error) {
    onError('Kamera değiştirilemedi: ' + (error.message || ''));
    return false;
  }
}

/// On/arka kamerayi cevirir. Yayin kesilmez; ayni yayin yeni kamerayla devam eder.
export async function switchFacing() {
  if (!room) return facing;
  const publication = pubFor(room.localParticipant, lib.Track.Source.Camera);
  const track = publication?.track || publication?.videoTrack;
  if (!track || typeof track.restartTrack !== 'function') {
    onError('Kamera açık değil');
    return facing;
  }
  const next = facing === 'user' ? 'environment' : 'user';
  try {
    // Belirli bir cihaz secilmediyse yon ile degistir; secildiyse secimi temizle.
    camDeviceId = null;
    await track.restartTrack({ facingMode: next });
    facing = next;
    torchOn = false;
    emit({ facing, torch: false, torchAvailable: torchAvailable() });
    return next;
  } catch (error) {
    onError('Kamera çevrilemedi: ' + (error.message || ''));
    return facing;
  }
}

export function getFacing() {
  return facing;
}

export async function toggleScreen(options = {}) {
  if (!room) return;

  // Capture card paylasimi acikken ekran paylasimi istenirse once kart kapatilir.
  if (cardPublishing) await stopCaptureCard();

  // Paylasim zaten aciksa kapat.
  if (room.localParticipant.isScreenShareEnabled) {
    try {
      await room.localParticipant.setScreenShareEnabled(false);
    } catch {}
    stopShareDeviceAudio();
    // Ekran paylasimi kapaninca yatay kilidi birak: kullanici telefonu normal
    // konumuna cevirebilir.
    kilidiBirak();
    emit({ screen: false });
    send?.({ op: 'voice_update', channelId, screen: false });
    return;
  }

  const preset = sharePreset();
  const wantsSystemAudio = shareAudioSource === 'sistem';
  const deviceId = shareAudioSource.startsWith('aygit:') ? shareAudioSource.slice(6) : null;

  try {
    await room.localParticipant.setScreenShareEnabled(
      true,
      {
        // Tarayici penceresindeki "sesi de paylas" kutusu yalnizca burada true
        // verilirse sorulur. Ayri bir ses aygiti secildiyse tarayicidan ses
        // istemeyiz; o izi asagida kendimiz yakalariz.
        audio: wantsSystemAudio,
        // Yakalama olcegi. frameRate'in resolution ICINDE olmasi sart: LiveKit
        // getDisplayMedia kisitlarini yalnizca buradan uretir; ust seviyeye
        // yazilan frameRate yalnizca kodlayiciya uygulanir.
        resolution: {
          width: preset.width,
          height: preset.height,
          frameRate: preset.frameRate
        },
        // 'text' ekran içeriği için metni ve kenarları korur; kodlayıcıya kare
        // hızını düşürmek yerine çözünürlüğü koruma eğilimi verir. Bulanıklığın
        // ana sebeplerinden biri buydu. Film izlerken 'motion' gönderilir.
        contentHint: options.contentHint || 'text',
        // Chrome'da tam ekran / sekme paylasiminda "sistem sesi" kutusunu
        // kendiliginden isaretler. Desteklemeyen tarayicilarda yok sayilir.
        ...(wantsSystemAudio ? { systemAudio: 'include' } : {})
      },
      {
        videoCodec: shareCodec,
        screenShareEncoding: { maxBitrate: preset.bitrate, maxFramerate: preset.frameRate },
        // Tek katman: SFU'nun izleyiciye alt katmani secmesini engeller (bkz.
        // yukaridaki simulcast aciklamasi). Yayin her zaman secilen on ayarin
        // cozunurlugunde ve kare hizinda gonderilir.
        simulcast: false,
        // Ekran sesi icin konusma profili yerine daha yuksek bit hizi ve dtx
        // kapali: aksi halde film/muzik sesi kesik kesik gider. red acik kalir.
        audioPreset: { maxBitrate: SCREEN_AUDIO_BITRATE },
        dtx: false
      }
    );

    // Ayri ses aygiti secildiyse onu ekran sesi olarak yayinla.
    if (deviceId) await publishShareDevice(deviceId);

    // Telefonda ekran paylasimi yatay goruntuye uygun: kilidi dene. Yalnizca
    // paylasim basariyla acildiktan sonra yapilir; tarayici desteklemiyorsa
    // sessizce gecilir ve kullanici elle dondurebilir.
    ekraniYatayKilitle();

    emit({ screen: true });
    send?.({ op: 'voice_update', channelId, screen: true });
    if (wantsSystemAudio) reportScreenAudio();
  } catch (error) {
    stopShareDeviceAudio();
    const message = String(error?.message || '');
    if (message.toLowerCase().includes('not supported') || message.toLowerCase().includes('getdisplaymedia')) {
      onError('Bu cihaz ekran paylaşımını desteklemiyor (mobil tarayıcılar desteklemez)');
    } else if (!message.toLowerCase().includes('cancel')) {
      onError('Ekran paylaşımı başlatılamadı');
    }
  }
}

/// Secilen ses girdisini yakalayip EKRAN SESI olarak yayinlar. Boylece sistem
/// sesi kutusunu isaretletmeyen tarayicilarda da (veya Stereo Mix / sanal kablo
/// uzerinden) ekran sesi gonderilebilir.
async function publishShareDevice(deviceId) {
  const { Track } = lib;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: deviceId },
      // Sistem/muzik sesini oldugu gibi aktarmak icin tarayici islemesi kapali;
      // yankiyi onleme filtresi muzigi belirgin sekilde bozar.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  });
  const track = stream.getAudioTracks()[0];
  if (!track) return;
  shareAudioTrack = track;
  await room.localParticipant.publishTrack(track, {
    source: Track.Source.ScreenShareAudio,
    audioPreset: { maxBitrate: SCREEN_AUDIO_BITRATE },
    dtx: false,
    red: true
  });
}

function stopShareDeviceAudio() {
  if (!shareAudioTrack) return;
  try {
    shareAudioTrack.stop();
  } catch {}
  shareAudioTrack = null;
}

/// Kalite on ayarini degistirir. Paylasim suruyorsa yakalama kisitlari CANLI
/// guncellenir: yeni bir "ekran sec" penceresi acilmaz, yayin kesilmez.
export async function setShareQuality(key) {
  if (!SHARE_QUALITIES[key]) return false;
  shareQuality = key;
  if (!room?.localParticipant?.isScreenShareEnabled) return true;

  const pub = pubFor(room.localParticipant, lib.Track.Source.ScreenShare);
  const track = pub?.track?.mediaStreamTrack;
  if (!track?.applyConstraints) return false;
  const preset = SHARE_QUALITIES[key];
  try {
    await track.applyConstraints({
      width: { ideal: preset.width },
      height: { ideal: preset.height },
      frameRate: { ideal: preset.frameRate }
    });
    return true;
  } catch {
    return false;
  }
}

/// Kodek degisikligi yayinin yeniden baslatilmasini gerektirir; bir sonraki
/// paylasimda gecerli olur.
export function setShareCodec(key) {
  if (!SHARE_CODECS[key]) return false;
  shareCodec = key;
  return true;
}

/// Paylasilacak ses kaynagi. Ayri aygit secimi de bir sonraki paylasimda
/// gecerli olur (tarayicidan sistem sesi izni yeniden alinmalidir).
export function setShareAudioSource(value) {
  shareAudioSource = String(value || SHARE_AUDIO_DEFAULT);
  return true;
}

/// Capture card secenekleri: aygit id'si ve (varsa) ses aygitlari.
/// Calisma zamani kart yoksa bos dizi doner; arayuz kullaniciya sorar.
export async function listCaptureDevices() {
  const empty = [];
  if (!navigator.mediaDevices?.enumerateDevices) return empty;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === 'videoinput');
    const mics = devices.filter((d) => d.kind === 'audioinput');
    // Kart adlarinda gecen anahtar kelimeler; kart yoksa "videoinput" olanlar
    // tek tek sunulur (kullanici kendisi secer).
    const ad = (d) => String(d.label || '').toLowerCase();
    const kart = cams.filter((d) => /capture|hdmi|usb|elgato|aver|magewell|blackmagic|intensity|live|gamer|game|capture card/i.test(ad(d)));
    const havuz = kart.length ? kart : cams;
    return havuz.map((v) => {
      const vAd = ad(v);
      const vidMatch = /\b([0-9a-f]{4}:[0-9a-f]{4})\b/i.exec(v.label);
      const usbId = vidMatch ? vidMatch[1].toLowerCase() : '';
      const kartMics = mics.map((a) => {
        const aAd = ad(a);
        const aVidMatch = /\b([0-9a-f]{4}:[0-9a-f]{4})\b/i.exec(a.label);
        const aUsbId = aVidMatch ? aVidMatch[1].toLowerCase() : '';
        const eslesiyor = Boolean(
          (v.groupId && a.groupId && v.groupId === a.groupId) ||
          (usbId && aUsbId && usbId === aUsbId) ||
          (vAd.includes('usb3') && aAd.includes('usb3')) ||
          (vAd.includes('4kpro') && aAd.includes('4kpro'))
        );
        return {
          id: a.deviceId,
          label: (a.label || 'Ses aygıtı') + (eslesiyor ? ' ★' : ''),
          eslesiyor
        };
      });
      kartMics.sort((x, y) => (y.eslesiyor ? 1 : 0) - (x.eslesiyor ? 1 : 0));
      return {
        id: v.deviceId,
        label: v.label || 'Capture card',
        audioDevices: kartMics
      };
    });
  } catch {
    return empty;
  }
}

export function getCardSettings() {
  return {
    quality: cardQuality,
    codec: cardCodec,
    audioSource: cardAudioSource,
    qualities: Object.entries(CARD_QUALITIES).map(([key, value]) => ({ key, label: value.label })),
    codecs: Object.entries(SHARE_CODECS).map(([key, value]) => ({ key, label: value.label }))
  };
}

export function setCardQuality(key) {
  if (!CARD_QUALITIES[key]) return false;
  cardQuality = key;
  return true;
}

export function setCardCodec(key) {
  if (!SHARE_CODECS[key]) return false;
  cardCodec = key;
  return true;
}

export function setCardAudioSource(value) {
  cardAudioSource = String(value || SHARE_AUDIO_DEFAULT);
  return true;
}

export function isCardPublishing() {
  return cardPublishing;
}

/// Capture card'in video+gelen sesini yayinlar. Video dogrudan kameradan
/// alinir; ses kaynagi 'aygit:<id>' ise secilen ses aygitindan yakalanir.
export async function toggleCaptureCard(deviceId) {
  if (!room) return;
  if (cardPublishing) {
    await stopCaptureCard();
    return;
  }
  let id = deviceId;
  if (!id) {
    const cards = await listCaptureDevices();
    if (cards.length) id = cards[0].id;
  }
  if (!id) {
    onError('Capture card seçilmedi');
    return;
  }
  // Ekran paylasimi acikken kart paylasilamaz; once ekran paylasimi kapatilir.
  if (room.localParticipant.isScreenShareEnabled) {
    try { await room.localParticipant.setScreenShareEnabled(false); } catch {}
  }
  try {
    let stream;
    const preset = CARD_QUALITIES[cardQuality] || CARD_QUALITIES[CARD_QUALITY_DEFAULT];
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: id },
          width: { ideal: preset.width },
          height: { ideal: preset.height },
          frameRate: { ideal: preset.frameRate }
        },
        audio: false
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: id },
        audio: false
      });
    }
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) throw new Error('kart_video_yok');
    cardTrack = videoTrack;

    await room.localParticipant.publishTrack(videoTrack, {
      source: lib.Track.Source.ScreenShare,
      videoCodec: cardCodec,
      screenShareEncoding: {
        maxBitrate: preset.bitrate,
        maxFramerate: preset.frameRate
      },
      simulcast: false,
      dtx: false
    });
    cardPublishing = true;

    if (cardAudioSource.startsWith('aygit:')) {
      const audioId = cardAudioSource.slice(6);
      if (audioId) await publishCardDeviceAudio(audioId);
    }
    emit({ screen: true });
    send?.({ op: 'voice_update', channelId, screen: true });
  } catch (error) {
    stopCardTracks();
    const msg = String(error?.message || '');
    onError(/denied|permission/i.test(msg) ? 'Capture card erişimi reddedildi' : 'Capture card başlatılamadı: ' + msg);
  }
}

async function publishCardDeviceAudio(deviceId) {
  try {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: deviceId, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
    }
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    cardAudioTrack = track;
    await room.localParticipant.publishTrack(track, {
      source: lib.Track.Source.ScreenShareAudio,
      audioPreset: { maxBitrate: SCREEN_AUDIO_BITRATE },
      dtx: false,
      red: true
    });
  } catch (err) {
    console.warn('Kart sesi yayınlanamadı:', err);
  }
}

function stopCardTracks() {
  try { cardTrack?.stop(); } catch {}
  cardTrack = null;
  try { cardAudioTrack?.stop(); } catch {}
  cardAudioTrack = null;
}

export async function stopCaptureCard() {
  if (!cardPublishing) return;
  try {
    await room.localParticipant.setScreenShareEnabled(false);
  } catch {}
  stopCardTracks();
  cardPublishing = false;
  emit({ screen: false });
  send?.({ op: 'voice_update', channelId, screen: false });
}

/// Ekran sesi yakalanmadiysa kullaniciyi bilgilendirir. Ses yalnizca paylasim
/// penceresindeki "sesi de paylas" kutusu isaretlendiginde gelir; sessiz kalirsa
/// karsi taraf hicbir sey duymaz ve sebebi anlasilmaz.
function reportScreenAudio() {
  const hasScreenAudio = () => {
    try {
      const pub = pubFor(room?.localParticipant, lib.Track.Source.ScreenShareAudio);
      return Boolean(pub?.track);
    } catch {
      return false;
    }
  };
  setTimeout(() => {
    if (!room?.localParticipant?.isScreenShareEnabled) return;
    if (hasScreenAudio()) return;
    onError('Ekran paylaşılıyor ama ses gelmiyor: pencere seçerken "sesi de paylaş" kutusunu işaretle');
  }, 1200);
}

export function updateIdentity(name) {
  if (!room) return;
  try {
    room.localParticipant.setMetadata(JSON.stringify({ displayName: name }));
  } catch {}
}

export async function leave() {
  if (!room) return;
  const id = channelId;
  // Ekran kilidi ve medya bildirimi serbest birakilir.
  kilidiBirak();
  releaseWakeLock();
  updateMediaSession(false);
  // Yerel uygulamada on plan servisi de kapatilir.
  if (yerelUygulama()) {
    try {
      window.SohbetNative.cagriDurdur();
    } catch {}
  }
  try {
    await room.disconnect();
  } catch {}
  for (const entry of pendingTracks.values()) {
    if (entry.camera) detachTrack(entry.camera);
    if (entry.screen) detachTrack(entry.screen);
    for (const slot of entry.audios || []) removeSlot(slot);
  }
  for (const track of gains.keys()) gains.delete(track);
  document.querySelectorAll('audio[data-peer]').forEach((node) => node.remove());
  pendingTracks = new Map();
  pubs.clear();
  stopCardTracks();
  cardPublishing = false;
  pttHolding = false;
  pttEnabled = false;
  vadEnabled = false;
  deafened = false;
  micBeforeDeafen = false;
  vadTemizle();
  room = null;
  channelId = null;
  send?.({ op: 'voice_leave', channelId: id });
  emit({ channelId: null, mic: false, cam: false, screen: false, torch: false, activeSpeakers: [], ptt: false, vad: false });
}

export function isReconnecting() {
  return reconnecting;
}
