# iobroker.redundancy adapteri — istifadə kitabçası

Versiya 0.0.1 · [English](../en/adapter.md) · [Ehtiyatlılıq sistemi](redundancy.md)

Adapter ehtiyatlılıq sisteminin ioBroker tərəfidir. O, heç nəyə **qərar vermir**: keçid, fence
və icarə (lease) watchdog xidmətinin işidir (bax:
[ehtiyatlılıq kitabçası](redundancy.md)). Adapter öz serverinin watchdog-unun gördüyünü göstərir
və serverin keçid üçün düzgün qurulduğunu yoxlayır.

## 1. Quraşdırma

Adapteri cütün **hər** serverində (A və B) quraşdırın, hər serverdə bir instansiya:

```
iobroker add redundancy --host <bu server>
```

və ya admin-də: Adapterlər → "SCADA redundancy" → instansiya əlavə edin və host-u seçin.

İlk başlanğıcda adapter `prebuilds/<platform>/`-dan yalnız öz platformasının native fayllarını
açır (Linux x64/arm64, Windows x64, macOS arm64/x64). Platforma dəstəklənmirsə, log bunu
yazır və instansiya dayanır.

## 2. Ayarlar

| Ayar | Mənası |
|---|---|
| **Watchdog status faylı** | bu serverin watchdog konfiqurasiyasındakı `statusFile`, məs. `/var/lib/scada/watchdog-status.json`. Onsuz rol naməlum qalır. |
| **Yoxlanacaq iobroker.json** | boş = bu serverin `iobroker.json`-u. Yalnız ioBroker başqasını işlədirsə doldurun. |

## 3. State-lər

Bütün state-lər yalnız oxunur.

| State | Dəyər |
|---|---|
| `redundancy.0.info.connection` | bu serverin watchdog-u işləyərkən `true` (status faylı 3 s-dən köhnə deyil) |
| `redundancy.0.role` | `primary`, `standby`, `fenced` və ya `offline` (watchdog yoxdur) |
| `redundancy.0.primary` | sistemin işlədiyi Redis master-in `ip:port`-u |
| `redundancy.0.epoch` | icarə nömrəsi; hər keçiddə artır, ona görə sıçrayış keçidin baş verdiyini göstərir |
| `redundancy.0.peer` | heartbeat xətlərinin gördüyü o biri server: `Ok`, `Degraded` (bəzi xətlər itib), `Isolated` (bütün xətlər itib, şahid hələ cavab verir), `Unconfirmed` (nə xətt, nə şahid), `Lost` |
| `redundancy.0.clientOptions` | bu serverin keçid üçün lazım olan Redis müştəri ayarlarının JSON siyahısı; `[]` = hər şey qaydasındadır |
| `redundancy.0.engineVersion` | native mühərrikin versiyası |
| `redundancy.0.watchdogInstall` | bu serverdə watchdog xidmətini quraşdıran əmr |

`role` və `epoch`-u vizuallaşdırmanızda və ya alarmlarda işlədin, məsələn "`role` dəyişəndə
alarm" və ya "`peer` `Ok` olmayanda alarm".

## 4. Müştəri ayarlarının yoxlanması

Başlanğıcda adapter bu serverin `iobroker.json`-unu oxuyur və keçidi yavaşladacaq və ya
ölümcül edəcək hər Redis müştəri ayarını loga yazır, məsələn:

```
error: …/iobroker.json: states.options keepAlive is missing, a switch needs 1000 (…)
```

`error` — server keçid zamanı dayana və ya bazasını itirə bilər; `warning` — keçid bir neçə
saniyə uzun çəkir. Düzgün dəyərlər
[ehtiyatlılıq kitabçasının 4.3 bölməsindədir](redundancy.md#43-hər-serverdə-iobrokerjson).
Faylı düzəltdikdən sonra instansiyanı yenidən başladın.

## 5. Watchdog-un adapterdən quraşdırılması

Watchdog ioBroker-dən kənarda, əməliyyat sisteminin xidməti kimi işləməlidir. Adapter onu
özü quraşdıra bilmir, çünki bunun üçün administrator hüquqları lazımdır.
`redundancy.0.watchdogInstall`-dan əmri köçürün, konfiqurasiya yolunuzu yazın və root və ya
administrator shell-də bir dəfə işə salın. Adapter yeniləndikdən sonra onu yenidən işə salın.

## 6. Problemlər

| Görürsünüz | Edin |
|---|---|
| `role = offline`, `info.connection = false` | watchdog işləmir, ya da status faylının yolu fərqlidir: xidməti və ayarı yoxlayın |
| logda `native engine: … not supported` | platforma dəstəklənən beş platformadan biri deyil |
| `cannot check …/iobroker.json` | ayarlarda yolu yazın və ya ioBroker istifadəçisinə oxuma icazəsi verin |
| `role = fenced` | server özünü qəsdən ayırıb; şəbəkəni düzəldin, ehtiyat kimi qayıdacaq |
| `clientOptions` `[]` deyil | orada sadalanan ayarları düzəldin (bölmə 4) |
