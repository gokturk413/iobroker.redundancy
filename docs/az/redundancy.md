# ioBroker üçün SCADA ehtiyatlılığı — istifadə kitabçası

`iobroker.redundancy` 0.0.1 versiyası · [English](../en/redundancy.md) · [Adapter](adapter.md)

Bu kitabça iki ehtiyatlı ioBroker serverini quran mühəndis və onları işlədən operator üçündür.

## 1. Nə əldə edirsiniz

İki ioBroker serveri, **A** və **B**, bir sistem kimi işləyir. Onlardan biri **əsas** (primary),
digəri **ehtiyat** (standby) serverdir. Hər ikisi eyni obyekt və state-ləri oxuyub yazır; bunlar
Redis-də saxlanılır və daim əsas serverdən ehtiyat serverə köçürülür.

| Hadisə | Nə baş verir | Ölçülüb |
|---|---|---|
| Əsas server sıradan çıxır (elektrik, şəbəkə kabeli, çökmə) | ehtiyat server özü əsas olur | ≈ 1.5 s, heç bir yazı itmir |
| Server o biri serverdən ayrılır | o biri idarəni götürməzdən əvvəl özünü dayandırır (fence), ona görə sistemdə heç vaxt iki əsas server olmur | fence ≈ 0.15 s, keçid son heartbeat-dən ≈ 0.25 s sonra |
| Sıradan çıxmış server qayıdır | ehtiyat kimi qoşulur və məlumatı köçürür | köçürmə ≈ 30 s |
| Planlı keçid (texniki xidmət) | yazılar dayanır, ehtiyat server idarəni götürür, yazılar davam edir | ≈ 1.3 s, heç bir yazı itmir |

**Avtomatik geri keçid yoxdur**: keçiddən sonra sistem yeni əsas serverdə qalır, siz onu
qəsdən keçirənə qədər.

## 2. Necə işləyir

```
        ┌──────────── server A ────────────┐        ┌──────────── server B ────────────┐
        │ ioBroker (js-controller, adapterlər)│      │ ioBroker (js-controller, adapterlər)│
        │        │ obyektlər + state-lər    │        │        │                          │
        │      Redis (master) ──────────────┼─surət─►│      Redis (replica)              │
        │      Sentinel                     │        │      Sentinel                     │
        │      watchdog ◄───────────────────┼─beat──►│      watchdog                     │
        └───────────────────────────────────┘        └───────────────────────────────────┘
                         ▲                                         ▲
                         └──────────── şahid Sentinel ─────────────┘
                                   (üçüncü kiçik maşın)
```

- **Redis** obyekt və state-ləri saxlayır. Əsas serverin Redis-i master, ehtiyat serverin
  Redis-i replica-dır.
- **Sentinel** (biri A-da, biri B-də, biri **şahid** maşında) hər müştəriyə hansı Redis-in
  master olduğunu deyir. Müştərilər həmişə Sentinel-lərdən soruşur, ona görə keçiddən sonra
  yeni master-i özləri tapırlar.
- **Watchdog** hər serverdə ioBroker-dən kənarda, əməliyyat sisteminin xidməti kimi işləyir;
  ioBroker dayananda da işləməyə davam edir. O:
  - verdiyiniz hər xətt üzrə (P2P kabel, fiber, LAN, WLAN) o biri serverə saniyədə 20 dəfə
    imzalı heartbeat göndərir;
  - Redis-də **əsas server icarəsini** (primary lease) saxlayır və yeniləyir;
  - ehtiyat serverdə: əsas server itəndə öz Redis-ini master edir;
  - əsas serverdə: öz Redis-inə çata bilmədikdə, ya da nə o biri serveri, nə də şahidi eşitmədikdə
    özünü **fence** edir (rol `fenced`) və sizin fence əmrinizi işə salır.
- **Adapter** serverin rolunu göstərir və onun ayarlarını yoxlayır (bax:
  [adapter](adapter.md)).

### Şahid nə üçündür

Yalnız iki server olanda aralarındakı qırılmış kabel hər ikisinə eyni görünür: "o biri yoxa
çıxdı". Şahid üçüncü rəydir. Şahidə hələ də çatan server işləməyə davam edir. Nə o biri
serverə, nə də şahidə çata bilməyən əsas server dayanır. Şahidə yalnız Sentinel lazımdır:
kiçik PC, VM və ya başqa maşında konteyner.

### İki əsas serverin qarşısını alan qayda

Əsas server əlaqəni itirəndən **150 ms** sonra özünü fence edir. Ehtiyat server yalnız
**250 ms** sonra idarəni götürür. Keçid fence-dən ən azı 50 ms sonra olmayan vaxt ayarlarını
watchdog qəbul etmir.

## 3. Tələblər

- ioBroker (js-controller 6 və ya daha yeni) olan iki server və bir şahid maşın.
- Linux x64/arm64 (glibc 2.35 və ya daha yeni: Debian 12, Ubuntu 22.04 və ya daha yeni),
  Windows x64 və ya macOS (Apple silicon və ya Intel). Docker konteynerləri dəstəklənir.
- A, B və şahiddə Redis 7 və Redis Sentinel.
- A ilə B arasında ən azı bir şəbəkə xətti; **iki müstəqil xətt** (məsələn, birbaşa kabel
  üstəgəl LAN) tövsiyə olunur. Hər xətt bir UDP portu işlədir (məs. 7001).
- A və B saatları arasında fərq 2 saniyədən az olmalıdır (NTP).

## 4. Quraşdırma, addım-addım

Nümunədə A = 192.168.64.11, B = 192.168.64.12, şahid = 192.168.64.1.

### 4.1 A və B-də Redis

Hər iki serverdə Redis-i işə salın. B, A-nın replica-sı kimi başlayır
(`replicaof 192.168.64.11 6379`). Tövsiyə olunan ayarlar:

```
replica-announce-ip <bu serverin IP-si>
repl-diskless-load swapdb        # qayıdan server surəti birbaşa yaddaşa yükləyir
repl-diskless-sync-delay 0       # master surəti göndərməzdən əvvəl 5 s gözləmir
```

### 4.2 A, B və şahiddə Sentinel

Hər üçündə eyni `sentinel.conf` (yalnız `announce-ip` fərqlidir):

```
port 26379
sentinel announce-ip <bu maşının IP-si>
sentinel monitor scada 192.168.64.11 6379 4
sentinel down-after-milliseconds scada 30000
sentinel failover-timeout scada 10000
sentinel parallel-syncs scada 1
```

3 Sentinel ilə kvorumun **4** olması qəsdəndir: Sentinel keçidi heç vaxt özü başlatmır;
bunu yalnız watchdog edir. Sentinel master-i tapmaq üçün işlədilir. `down-after`-i 30000-də
saxlayın: daha qısa dəyərlər keçidi sürətləndirmir, əksinə yavaşladır.

### 4.3 Hər serverdə `iobroker.json`

`objects` və `states`-i üç Sentinel-ə yönəldin, bu ayarlarla:

```json
"states": {
  "type": "redis",
  "host": ["192.168.64.11", "192.168.64.12", "192.168.64.1"],
  "port": [26379, 26379, 26379],
  "sentinelName": "scada",
  "options": {
    "retry_max_delay": 150,
    "retry_max_count": 100000,
    "failoverDetector": false,
    "connectTimeout": 1000,
    "maxRetriesPerRequest": null,
    "keepAlive": 1000
  }
}
```

`objects` da eynisini alır. Hər ayar ölçdüyümüz bir nasazlığı aradan qaldırır:

| Ayar | Nə üçün |
|---|---|
| `retry_max_delay: 150` | müştəri 5 s yox, 150 ms ərzində yenidən qoşulur |
| `retry_max_count: 100000` | müştəri saatlarla cəhd edir; standart dəyərlə 95 s sonra birdəfəlik əl çəkir |
| `failoverDetector: false` | açıq olanda keçid zamanı əmrləri kəsir və js-controller bütün adapterləri yenidən başladır |
| `connectTimeout: 1000` | ölü ünvan 10 s yox, 1 s aparır |
| `maxRetriesPerRequest: null` | əmr 20 cəhddən sonra səhv vermir, yeni master-i gözləyir |
| `keepAlive: 1000` | yoxa çıxmış server heç nə göndərmir; keepalive olmadan gözləyən bağlantı bunu heç vaxt hiss etmir |

Multihost slave-lər keçiddən sonra işləməyə davam edir: onlar da Sentinel-lərdən soruşur.

### 4.4 Linux: TCP ayarı

```
echo 'net.ipv4.tcp_retries2 = 3' | sudo tee /etc/sysctl.d/90-scada-ha.conf
sudo sysctl --system
```

Docker-də bunu ioBroker konteynerinə verin (compose faylında
`sysctls: { net.ipv4.tcp_retries2: "3" }`). Yoxa çıxmış server TCP reset göndərmir; Linux-un
standart 15 dəyəri ilə Redis əmri 15 dəqiqəyə qədər gözləyir. 3 ilə təxminən 3 saniyədən sonra
əl çəkir (ölçülüb: donma əvəzinə müştəri fasiləsi 6.8 s). Bu, həmin host və ya konteynerin bütün
TCP bağlantılarına aiddir.

### 4.5 Watchdog konfiqurasiyası

Hər server üçün bir JSON faylı; `me` və xətt ünvanlarından başqa hər ikisində eynidir. A üçün
nümunə:

```json
{
  "cluster": "plant-1",
  "me": "A",
  "keyHex": "<64 hex simvol, A və B-də eyni>",
  "sentinelName": "scada",
  "sentinels": ["192.168.64.11:26379", "192.168.64.12:26379", "192.168.64.1:26379"],
  "witness": "192.168.64.1:26379",
  "hosts": [
    { "name": "A", "priority": 1, "redis": "192.168.64.11:6379" },
    { "name": "B", "priority": 2, "redis": "192.168.64.12:6379" }
  ],
  "links": [
    { "name": "lan",  "medium": "lan", "bind": "192.168.64.11:7001", "peer": "192.168.64.12:7001" },
    { "name": "p2p",  "medium": "p2p", "bind": "10.10.10.1:7001",    "peer": "10.10.10.2:7001" }
  ],
  "statusFile": "/var/lib/scada/watchdog-status.json",
  "logFile": "/var/log/scada/watchdog.log"
}
```

Açarı bir dəfə yaradın və hər iki serverə köçürün. **Gizli saxlayın**: ona sahib olan hər kəs
heartbeat göndərə bilər.

```
openssl rand -hex 32
```

| Sahə | Mənası |
|---|---|
| `cluster` | bu cütün adı; başqa klasterin beat-ləri nəzərə alınmır |
| `me` | bu serverin adı, `hosts`-dan biri |
| `keyHex` | heartbeat açarı, hex şəklində ən azı 32 bayt |
| `sentinelName` | `sentinel monitor`-dakı ad (standart `scada`) |
| `sentinels` | bütün Sentinel-lər, `ip:port` |
| `witness` | şahid Sentinel (`sentinels`-də də olmalıdır) |
| `hosts` | bütün serverlər: `name`, `priority` (1 = üstünlük verilən), `redis` (`ip:port`) |
| `links` | heartbeat xətləri: `name`, `medium` (`p2p`, `fiber`, `lan`, `wlan`), `bind` (yerli `ip:port`), `peer` (o biri serverin `ip:port`-u), istəyə görə `missed` |
| `beatMs` | heartbeat intervalı, standart 50 ms |
| `timing` | istəyə görə `{fenceAfterMs, takeoverAfterMs, leaseTtlMs}`, standart 150 / 250 / 5000 |
| `witnessRequired` | istəyə görə; şahidsiz və peer-siz qalan əsas server fence olur |
| `fenceCommand`, `unfenceCommand` | istəyə görə əmr (siyahı kimi, məs. `["/usr/local/bin/stop-serial.sh"]`), bu server fence olanda və ya geri qayıdanda işə düşür |
| `statusFile` | watchdog hər 250 ms öz vəziyyətini bura yazır; adapter onu oxuyur |
| `logFile` | log sətirləri (JSON) bura yazılır; konsolu olmayan Windows xidməti üçün lazımdır |

Xətt 3 buraxılmış beat-dən sonra (WLAN: 10) itmiş sayılır, yəni 50 ms beat ilə 150 ms.

### 4.6 Yoxlayın, sonra watchdog-u quraşdırın

Watchdog faylları adapterlə gəlir (`prebuilds/<platform>/`). Adapterin
`redundancy.0.watchdogInstall` state-i sizin serverdəki dəqiq yolu göstərir.

```
redundancy-watchdog check /etc/scada/watchdog.json --iobroker /opt/iobroker/iobroker-data/iobroker.json
```

`check` konfiqurasiyanı, TCP ayarını (Linux) və Redis müştəri ayarlarını oxuyur və hər biri
üçün `ok`, `warn` və ya `ERROR` deyir. Davam etməzdən əvvəl hər `ERROR`-u düzəldin.

Onu bir dəfə əməliyyat sisteminin xidməti kimi quraşdırın:

| Sistem | Əmr | Necə işləyir |
|---|---|---|
| Linux | `sudo redundancy-watchdog install /etc/scada/watchdog.json` | systemd unit `scada-redundancy-watchdog` |
| macOS | `sudo redundancy-watchdog install "/Library/Application Support/SCADA/watchdog.json"` | launchd daemon `com.scada.redundancy-watchdog` |
| Windows | `redundancy-watchdog.exe install C:\ProgramData\SCADA\watchdog.json` (admin shell) | Windows xidməti `scada-redundancy-watchdog` |
| Docker | Redis-in yanında `redundancy-watchdog run /config/watchdog.json` və `network_mode: host` ilə konteyner | konteyner |

Xidmət maşınla birlikdə başlayır və çökmədən bir saniyə sonra yenidən işə düşür. Silmək üçün
`redundancy-watchdog uninstall`. Watchdog faylını yerində saxlayın; adapter yeniləndikdən sonra
`install`-u yenidən işə salın ki, xidmət yeni faylı işlətsin.

## 5. İşə buraxmazdan əvvəl: testlər

Hər testi bir dəfə, ioBroker işləyərkən və məlumat axarkən edin:

1. **Əsas serverin elektrikini və ya şəbəkəsini kəsin.** Ehtiyat server təxminən 2 saniyəyə
   `primary` olmalıdır; qalan serverin adapteri `role = primary` və daha böyük `epoch` göstərir.
2. **Onu geri qaytarın.** O, `standby` kimi qayıtmalıdır; geri keçid baş vermir.
3. **Yalnız bir heartbeat xəttini çıxarın.** Heç nə keçmir; watchdog logu ehtiyatlılığın
   azaldığını yazır.
4. **A ilə B arasındakı bütün xətləri çıxarın, amma şahid əlçatan qalsın.** Əsas server
   işləməyə davam edir; ehtiyat server idarəni götürmür.
5. **Əsas serveri hər şeydən ayırın.** O, bir saniyə ərzində `fenced` göstərməlidir, ehtiyat
   server idarəni götürür.

## 6. Gündəlik istismar

- **Hansı server əsasdır?** Hər serverdə `redundancy.0.role` və ya `redundancy.0.primary`.
- **Watchdog logları:** `journalctl -u scada-redundancy-watchdog` (Linux),
  `/var/log/scada-redundancy-watchdog.log` (macOS), `logFile` (Windows və digərləri).
- **Server `fenced` göstərir:** o, özünü qəsdən ayırıb. Şəbəkəni düzəldin; o özü ehtiyat kimi
  qayıdır.
- **`role = offline`:** həmin serverin watchdog-u işləmir. Xidməti başladın.
- **Serverin yenilənməsi:** əvvəl ehtiyat serveri yeniləyin, sonra keçid edin, sonra o birini
  yeniləyin.
- **Elektrik kəsiləndən sonra Redis başlamır** və logda `Bad file format reading the append
  only file … incr.aof` yazılır: sərt dayanma faylın sonunu yarımçıq qoyub, bəzən hər iki
  serverdə eyni anda. Əvvəl sonuncu master olan serveri bərpa edin, sonra o birini; o, məlumatı
  birincidən köçürəcək. Docker-də, stack qovluğunda:

  ```
  docker stop scada-redis
  docker run --rm -v ./redis-data:/data --entrypoint sh <redis image> -c \
    'cd /data && cp -a appendonlydir appendonlydir.bak && echo y | redis-check-aof --fix appendonlydir/<logda adı çəkilən fayl>'
  docker start scada-redis
  ```

  Yalnız elektrik kəsilməzdən əvvəlki son anın yazıları itir; ehtiyat nüsxə
  `appendonlydir.bak`-da qalır.

## 7. Bu versiyada hələ yoxdur

- Admin-də keçid düyməsi və keçid tarixçəsi (planlı keçid mühərrikdə hazırdır və adapterin
  növbəti versiyası ilə gəlir).
- Ayrı-ayrı adapter instansiyalarının (məsələn, serial və ya Modbus RTU) yeni əsas serverə
  köçürülməsi.
- Virtual IP ünvanı.
