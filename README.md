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
   - `handOff`: mesaj Discord'a gönderilir, sonuç `PATCH /devicerequests/:id/sendresult` ile bildirilir. Bağlayıcıda o
     `discordUserId` için token yoksa Discord çağrılmaz; yanıt `{ outcome: 'failed', reason: 'Bağlayıcıda bu hesabın tokeni yok',
     tokenMissing: true }` olur (gönderim duraklatılmış olsa bile).
   - `guildChannels`: sunucular ve metin kanalları listelenir, 15 saniye içinde `PATCH /devicerequests/:id/guildchannels` ile yanıtlanır.
     Liste alınamıyorsa platformun 15 saniyesi beklenmez, hemen `{ unavailableReason }` (`guilds` olmadan) gönderilir:
     token yoksa `tokenMissing`, Discord'a ulaşılamıyorsa (ağ hatası, 5xx, hız sınırı) `discordUnavailable`. Discord tokeni
     reddederse (401) yanıt eskisi gibi `{ guilds: [], tokenRejected: true }` olur.
4. **Beklenen hesaplar.** `GET /deviceexpectedaccounts` eşleştirmeden sonra (her bağlantı kuruluşunda), pencere açıldığında,
   hesap eklenip kaldırıldığında ve çevrimiçiyken her 60 saniyede çağrılır. Yanıt, platformun bu cihazdan gönderim yapmasını
   beklediği `connector` yollu hesaplardır (`boundToThisDevice: true`) ve artık canlı olmayan bir cihaza bağlı ya da hiçbir cihaza
   bağlı olmayan hesaplardır (`boundToThisDevice: false`, yeniden eşleştirme adayları). Pencerede, bu bilgisayarda tokeni olmayan
   hesaplar "Token bekleyen hesaplar" kartında listelenir ("Bu hesap için token girin" / "Önceki bir cihazdan") ve **Token ekle**
   ile olağan hesap ekleme formu o hesaba hedeflenir. Girilen token başka bir hesaba aitse platforma hiçbir şey bildirilmeden reddedilir.
   Kullanıcının bu programda kaldırdığı hesaplar (`disconnectReason: 'connector-removed'`, `boundToThisDevice: true`) bu kartta
   gösterilmez; "Discord hesapları" kartının altındaki sessiz "Kaldırılan hesaplar" listesinde **Yeniden ekle** ile durur.
5. **Hesap ekleme.** Token önce yerelde Discord'a (`GET /users/@me`) doğrulatılır, sonra yalnızca hesap bilgisi
   `POST /connectoraccountreports` ile bildirilir. Platform kabul ederse token şifreli olarak saklanır. Önceki (kaldırılmış) bir
   cihaza bağlı hesap bu çağrıyla bu cihaza yeniden bağlanır.
6. **Hesap kaldırma.** Önce `POST /connectoraccountremovals` `{ discordUserId }` çağrılır (yanıt
   `{ removal: { result: 'released' | 'notBound', accountId } }`; ikisi de başarı), sonra token yerelde silinir. Sunucuya
   ulaşılamazsa ya da istek reddedilirse token yine silinir, durum günlüğe yazılır ve kullanıcıya hesabın panelde hâlâ bağlı
   görünebileceği söylenir.
7. **Eşleştirmeyi kaldırma.** Önce `PATCH /connectorselfrevoke` (yanıt `{ id, revoked }`) ile cihaz platformda iptal edilir, sonra
   tüm yerel durum silinir. `401` "zaten iptal edilmiş" sayılır (başarı). Ağ hatasında (ya da başka bir hatada) yerel durum yine silinir ve pencerede cihazın
   web panelindeki Cihazlar sayfasından da kaldırılması gerekebileceği gösterilir.
8. **İptal.** Herhangi bir çağrı `401 errMsg_DeviceCredentialInvalid` dönerse cihaz web panelinden kaldırılmış demektir:
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
- Hesap kaldırıldığında tokeni silinir (platforma yalnızca `discordUserId` bildirilir). "Eşleştirmeyi kaldır" cihazı platformda
  iptal eder ve tüm yerel durumu siler.

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
5. **Test derlemesi:** `vX.Y.Z-preview.N` biçiminde bir etiket (ör. `git tag v0.1.0-preview.1 && git push origin v0.1.0-preview.1`)
   aynı derlemeyi **önizleme** API'siyle yapar ve doğrudan indirilebilen bir **ön sürüm** (pre-release) yayınlar. Elle
   başlatmada `env` girdisi `preview` seçilerek de önizleme derlemesi alınır.

## Açık konular

- **Kod imzalama ve notarization (gerçek dağıtımdan önce şart).** Derlemeler imzasızdır. macOS'ta Gatekeeper uygulamayı engeller:
  Apple Developer ID sertifikası, `hardenedRuntime` ve notarization (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`,
  `CSC_LINK`, `CSC_KEY_PASSWORD` gizli değişkenleri) eklenmeli. Windows'ta SmartScreen uyarısı çıkar: bir kod imzalama sertifikası
  (`WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`) gerekir.
- **Otomatik güncelleme yok.** Yeni sürüm elle kurulmalı.
- **Web panelindeki indirme bağlantıları** `VITE_CONNECTOR_DOWNLOAD_MAC` / `VITE_CONNECTOR_DOWNLOAD_WIN` değişkenlerinden okunur;
  boşken bağlantılar gizlidir. İlk sürüm yayınlandığında bu değişkenler sürüm dosyalarının adresleriyle doldurulmalı.
- **Kanal listesi alan adı:** bağlayıcı spesifikasyonu `channelId` derken web istemcisi ve platform yolu `discordChannelId` okuyor.
  Bağlayıcı her iki alanı da gönderir.
- **R19 cihaz API'leri** (`GET /deviceexpectedaccounts`, `POST /connectoraccountremovals`, `PATCH /connectorselfrevoke`,
  `tokenMissing`, `unavailableReason`) bağlayıcıda sözleşmeye göre uygulandı, sahte HTTP katmanıyla test edildi ve önizleme
  arka ucuna karşı canlı smoke testiyle doğrulandı. Bu API'ler yoksa (ör. eski arka uç, `404`) bağlayıcı çalışmaya devam eder:
  beklenen hesap listesi boş kalır, kaldırma ve eşleştirmeyi kaldırma yerelde tamamlanır.
- Discord istekleri platform modülüyle aynı `User-Agent` dizesini gönderir (`src/core/discord.ts`, `PLATFORM_USER_AGENT`).
  Platform modülü değişirse burası da güncellenmeli.
- Linux desteklenmez (platform alanı yalnızca `windows` ve `macos` kabul eder).
