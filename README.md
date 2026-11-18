# GTextHub Bağlayıcı

GTextHub'ın masaüstü bağlayıcısı (Windows ve macOS). Kullanıcının bilgisayarında arka planda, sistem tepsisinde çalışır ve
zamanlanmış Discord mesajlarını **kullanıcının kendi bilgisayarından** gönderir. Discord tokenleri bu bilgisayardan hiç çıkmaz;
GTextHub platformuna yalnızca hesabın Discord kimliği, adı ve avatarı bildirilir.

## Nasıl çalışır

1. **Eşleştirme.** Kullanıcı web panelindeki *Cihazlar* sayfasından tek kullanımlık, 10 dakika geçerli bir kod alır ve bağlayıcıya
   girer. Bağlayıcı `POST /devicepairings` ile kodu cihaz kimliği (`deviceId`) ve cihaz anahtarı (`deviceCredential`) ile değiştirir.
   Cihaz adı varsayılan olarak bilgisayarın adıdır, platform otomatik algılanır.
2. **Nabız.** Her 30 saniyede `PATCH /connectorheartbeat`. Platform 2 dakika nabız almazsa cihazı çevrimdışı sayar.
3. **İstek kuyruğu.** Her 3 saniyede `GET /devicerequests/pending` (gerçek zamanlı hub kurulmadı; cihaz yoklama yapar).
   Her istek kimliğine göre yalnızca bir kez işlenir (kalıcı günlük: yeniden başlatmada bile aynı mesaj iki kez gönderilmez).
   - `handOff`: mesaj Discord'a gönderilir, sonuç `PATCH /devicerequests/:id/sendresult` ile bildirilir.
   - `guildChannels`: sunucular ve metin kanalları listelenir, 15 saniye içinde `PATCH /devicerequests/:id/guildchannels` ile yanıtlanır.
4. **Hesap ekleme.** Token önce yerelde Discord'a (`GET /users/@me`) doğrulatılır, sonra yalnızca hesap bilgisi
   `POST /connectoraccountreports` ile bildirilir. Platform kabul ederse token şifreli olarak saklanır.
5. **İptal.** Herhangi bir çağrı `401 errMsg_DeviceCredentialInvalid` dönerse cihaz web panelinden kaldırılmış demektir:
   bağlayıcı durur, yerel anahtarı ve tokenleri siler ve yeniden eşleştirme ister.

Mesaj gecikmesi, yasaklı kelimeler ve lisans kontrolleri platformda, gönderim bağlayıcıya verilmeden önce yapılır.
Bağlayıcı yalnızca kendisine verilen gönderimleri yürütür.

Discord çağrıları platformun kendi modülüyle (`discordRequest.js`) aynı şekilde yapılır: aynı uç noktalar, aynı `Authorization`
kullanımı, aynı hata eşlemesi ve aynı Türkçe hata metni (ör. `İzin yok (Discord 403 · 50013 · Missing Permissions)`).
`429` yanıtında Discord'un `retry_after` süresi boyunca o token ile Discord'a istek gönderilmez; otomatik yeniden deneme yoktur.

## Güvenlik

- Cihaz anahtarı ve tüm Discord tokenleri yalnızca Electron `safeStorage` ile (macOS Anahtar Zinciri / Windows DPAPI) şifrelenmiş
  olarak `userData/secrets.bin` içinde tutulur. İşletim sistemi şifrelemesi yoksa eşleştirme ve hesap ekleme devre dışıdır.
- Token yalnızca Discord'a, cihaz anahtarı yalnızca bağlayıcı API başlıklarına (`x-device-id`, `x-device-credential`) gider.
  Pencereye hiçbir gizli bilgi geri gönderilmez.
- Günlük dosyası `userData/logs/connector.log`; tüm satırlar gizli bilgi ayıklamasından geçer.
- Hesap kaldırıldığında tokeni silinir. "Eşleştirmeyi kaldır" tüm yerel durumu siler.

## Geliştirme

Gereksinimler: Node.js 24, npm 11.

```bash
npm install            # bağımlılıklar (Electron ikili dosyası dahil)
npm run dev            # derler ve uygulamayı başlatır (önizleme API'si)
npm test               # vitest: çekirdek ve denetleyici testleri (sahte HTTP katmanı, gerçek Discord yok)
npm run build          # tip denetimi + esbuild paketleme -> dist/
npm run icons          # build/ ve assets/ altındaki simgeleri yeniden üretir
npm run dist:mac       # yerelde imzasız dmg (arm64 + x64)
npm run dist:win       # yerelde imzasız NSIS kurulum dosyası
```

### API adresi

API adresi derleme anında seçilir:

| Ortam | `GTH_ENV` | Adres |
|---|---|---|
| Önizleme (varsayılan, `npm run dev`) | boş / `preview` | `https://xkjhy36p.mindbricks.dev/connector-api` |
| Üretim (sürüm iş akışı) | `production` | `https://xkjhy36p.mindbricks.app/connector-api` |

Yalnızca geliştirme sırasında (paketlenmemiş uygulama) geçersiz kılınabilir: `GTH_API_BASE` ortam değişkeni ya da proje kökünde
`dev-config.json` (`dev-config.example.json` dosyasını kopyalayın). Rotalar `/v1` öneki olmadan, temel adresin hemen altında çağrılır.

Geliştirme verileri kurulu uygulamadan ayrı bir klasörde tutulur (`GTextHub Bağlayıcı (dev)`); `GTH_USER_DATA` ile başka bir klasör
seçilebilir.

### Klasör yapısı

```
src/core/       saf Node: API istemcisi, Discord istemcisi, cihaz döngüsü, istek günlüğü, hesap akışları (Electron yok)
src/main/       Electron ana süreç: tepsi, pencere, şifreli depolama, IPC, oturum açılışında başlatma
src/preload/    pencereye dar ve tipli bir köprü (window.connector)
src/renderer/   tek pencere: düz TS/HTML/CSS, Türkçe, Static Amethyst renkleri
src/shared/     ana süreç ile pencere arasındaki tipler
test/           vitest testleri
scripts/        esbuild derlemesi ve simge üretimi
```

## Sürüm akışı

1. `package.json` sürümünü yükseltin: `npm version patch` (ya da `minor` / `major`). Bu bir `vX.Y.Z` etiketi oluşturur.
2. `git push --follow-tags`.
3. `.github/workflows/release.yml` testleri çalıştırır, macOS (dmg, arm64 + x64) ve Windows (NSIS, x64) kurulum dosyalarını
   **üretim** API adresiyle derler ve etiket için **taslak** bir GitHub sürümü oluşturup dosyaları ekler.
4. Taslağı kontrol edip yayınlayın. İş akışı Actions sekmesinden elle de başlatılabilir (yalnızca derleme dosyaları, sürüm yok).

## Açık konular

- **Kod imzalama ve notarization (gerçek dağıtımdan önce şart).** Derlemeler imzasızdır. macOS'ta Gatekeeper uygulamayı engeller:
  Apple Developer ID sertifikası, `hardenedRuntime` ve notarization (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`,
  `CSC_LINK`, `CSC_KEY_PASSWORD` gizli değişkenleri) eklenmeli. Windows'ta SmartScreen uyarısı çıkar: bir kod imzalama sertifikası
  (`WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`) gerekir.
- **Otomatik güncelleme yok.** Yeni sürüm elle kurulmalı.
- **Web panelindeki indirme bağlantıları** henüz yok (Cihazlar sayfası "yakında" diyor); yayınlanan sürüm dosyalarına bağlanmalı.
- **Arka uç eksikleri** (bağlayıcıdan çözülemeyen):
  - Cihazın, platformun bu cihaza bağlı beklediği hesapları öğrenebileceği bir API yok. Web panelinde yolu "bağlayıcı" yapılan bir
    hesap, kullanıcı tokeni bu bağlayıcıya girene kadar "Bağlayıcı bekleniyor" durumunda kalır.
  - Bağlayıcıdan hesap kaldırmak platforma bildirilemez (yalnızca `tokenValid: false` bildirimi var ve bu, hesabı "token reddedildi"
    olarak işaretler). Kullanıcı hesabı web panelinden de silmelidir.
  - "Eşleştirmeyi kaldır" için cihaz tarafında bir API yok; cihaz web panelinden de kaldırılmalıdır.
  - Kanal listesi alan adı: bağlayıcı spesifikasyonu `channelId` derken web istemcisi ve platform yolu `discordChannelId` okuyor.
    Bağlayıcı her iki alanı da gönderir.
- Discord istekleri platform modülüyle aynı `User-Agent` dizesini gönderir (`src/core/discord.ts`, `PLATFORM_USER_AGENT`).
  Platform modülü değişirse burası da güncellenmeli.
- Linux desteklenmez (platform alanı yalnızca `windows` ve `macos` kabul eder).
