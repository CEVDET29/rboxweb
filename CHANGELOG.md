# Değişiklik günlüğü — RboxWeb (site + ajan)

Sürüm numarası ajanın csproj `<Version>` değeridir; arayüzde ajan rozetinde görünür.
Bu dosya 0.22.2 ile başlatıldı; önceki sürümlerin notları kayıtlı değildir.

## 0.27.0 — 2026-11-16
WPF 1.62.0, 1.63.1 ve 1.63.2 ile aynı (yalnızca site).
- Tüm tablolarda **itmeli sütun boyutlandırma**: iki sütun arasındaki çizgi sola çekilince sağdaki sütun genişler; yer önce esnek sütundan (ör. Hasta, ADİ), sonra çizgiye en yakın sütunlardan alınır, hiçbir sütun kaybolmaz (en az 36 px). Sağa çekince soldaki sütun genişler; yer sağdaki sütunlardan alınır, yetmezse tablo yatay kayar. Çizgiye çift tıklama sütunu içeriğine göre boyutlandırır.
- Cihaz Güncelleme: cihaz listesi ile seçenekler alanı arasına sürüklenebilir **ayraç**; seçenekler alanı 440 px'ten ızgaranın ~%65'ine kadar genişler, genişlik tarayıcıda hatırlanır, çift tıklama varsayılana döndürür. Dar ekranda (≤ 1150 px, tek sütun) ayraç gizlenir.
- Seçenekler alanının en küçük genişliği, servis satırlarının (etiket + Dokunma … Durdur) tek satıra sığdığı genişliktir; yazı tipi / yakınlaştırmaya göre ölçülür, ilk açılışta da uygulanır.

## 0.26.1 — 2026-11-16
WPF 1.63.3 ile aynı (yalnızca site).
- Cihaz Güncelleme: seçenek satırı etiketleri kısaldı ("swtui servisi" → swtui, "Web servisi" → web, "cron servisi" → cron; tam birim adı ipucunda) ve etiket sütunu 92 → 68 px; servis satırları 440 px'lik varsayılan alana tek satırda sığar.

## 0.26.0 — 2026-11-16
WPF 1.63.0 ile aynı.
- Cihaz Güncelleme → Sistem: yeni **swtui servisi** ve **Web servisi** satırları (Dokunma / Enable / Disable / Başlat / Durdur), seçili tüm cihazlarda toplu çalışır. Enable: açılışta başlasın + hemen başlat; Disable: açılışta başlamasın + hemen durdur; Başlat / Durdur yalnız şimdi (açılış ayarına dokunmaz). Sonuç gerçek duruma (is-enabled / is-active) göre raporlanır; servis cihazda kurulu değilse uyarıyla atlanır. Kurulum (swtui / Web server) da seçiliyse önce kurulum yapılır. "Tümünü seç" bu satırları değiştirmez, "Kaldır" Dokunma'ya alır.
- Ajan: güncelleme seçeneklerine `swtuiService` / `webService` (WPF ile aynı UpdateCoordinator).

## 0.25.2 — 2026-11-16
WPF 1.61.3 ile aynı (yalnızca site).
- YBDB → Cihazlar tablosunda Yoğun bakım hücresinde oda adının solunda bölüm rengi (Odalar / Yataklar ekranıyla aynı renk). Tarayıcının açılır listesindeki seçeneklerde renk gösterilemez.

## 0.25.1 — 2026-11-16
WPF 1.61.2 ile aynı (yalnızca site).
- YBDB → Cihazlar tablosundaki Yoğun bakım / Yatak listeleri normalde düz metin gibi görünür; satırın üzerine gelince ya da satır seçiliyken ince kenarlık ve ok çıkar. Boş oda soluk "—", "Yatak yok" soluk ve italik.

## 0.25.0 — 2026-11-16
WPF 1.60.0 / 1.61.0 TTY dosya paneli web'e taşındı.
- TTY penceresinin solunda **dosya paneli** (başlıktaki klasör düğmesiyle açılır / kapanır, aradaki çizgiden genişlik ayarlanır; ikisi de tarayıcıda hatırlanır): geri / ileri / üst / ev / yenile, tıklanabilir yol (yola tıklayıp yazılabilir, `~` desteklenir; dosya yolu yazılırsa klasörü açılıp dosya seçilir), sütun sıralama (klasörler önce), gizli dosyalar aç / kapat, yer imleri (varsayılan: /home/pi, publish, /etc, /etc/systemd/system).
- Yeni klasör, yeniden adlandır (F2), sil (Delete, onaylı), çoklu seçim (Ctrl / Shift), sağ tık menüsü, yolu kopyala. Metin dosyası çift tıkla TTY1'de `sudo nano` ile açılır; .deb için **Kur** (`sudo apt install -y`, onaylı); "Bu klasörde TTY1'i aç".
- Tarayıcıya özgü farklar: **İndir** dosyayı tarayıcıya indirir (birden çok öğe ya da klasör zip olur); **Yükle** dosya seçici ya da panele sürükle-bırak (aynı adlı dosyalar için üzerine yazma onayı; klasör sürüklenemez); **updateFiles'ten yükle** ajanın updateFiles klasöründen seçtirir; yer imleri tarayıcıda saklanır.
- TTY başlığına **Konsolu temizle** düğmesi (TTY1'e Ctrl+L gönderir).
- Ajan: `/api/control/files/list|stat|mkdir|rename|delete|exists|upload|upload-work|download|close` (SFTP, gerekirse sudo; WPF ile aynı RemoteFiles kodu). Oturum 2 dk kullanılmazsa kapanır.

## 0.24.1 — 2026-11-16
WPF 1.61.1 ile aynı.
- YBDB → Cihazlar tablosuna **Yoğun bakım** ve **Yatak** sütunları: her satırda açılır liste. Oda seçilince yatak listesi o odanın yataklarıyla dolar; yatak seçilince YatakId hemen veritabanına yazılır (satır başkası tarafından değiştirilmişse yazılmaz, uyarı verilir). "— Yatak yok —" YatakId'yi boşaltır. Ajan kodu değişmedi (yalnızca site).

## 0.24.0 — 2026-11-13
WPF 1.55.0–1.59.0 değişiklikleri web'e taşındı (1.58.3 yalnız WPF'e özgü olduğu için hariç).
- Arayüz kompakt: lacivert üst bant yerine sol ikon şeridi (modüller yalnız simge, adı ipucunda; altta tam ekran, kompakt, tema, çıkış). Sayfa başlığı, ajan, SSH ve cihaz listesi ince üst çubukta. Tam ekranda (F) ikon şeridi kalır. Dar ekranda (≤ 900 px) eski üst bant düzeni.
- Cihaz Kontrol → GENEL KONTROL: yeni **Kart | Liste** seçimi (tarayıcıda hatırlanır). Liste görünümünde her cihaz bir satır: yatak / oda, IP, durum, hizmet kareleri (SW, WEB, TUI, CRON; tıklanarak aç / kapat), sıcaklık, CPU, RAM, disk, çalışma süresi ve işlem düğmeleri. Oda grupları ve daralt / genişlet aynen çalışır.
- Kart ve liste satırına **TTY ekranını göster** düğmesi: cihazın konsolu sayfanın üstünde yüzen küçük bir panelde ~1 sn arayla, renkleriyle görünür. TTY1 | TTY2 seçimi (açılışta TTY2 = swtui), duraklat; cihaz başına tek panel, başlıktan sürüklenir, sağ alttan genişletilir.
- TTY1'e yazılabilir: ekrana tıklayıp doğrudan yazın (Enter, oklar, Tab, F1–F12, Ctrl+harf, Alt+harf; ör. Alt+R gibi bash kısayolları; Ctrl+V yapıştırır) ya da alttaki kutuya komut yazıp Enter. Tuşlar cihazda konsolun girişine konur (TIOCSTI, sudo ile); monitörde açık ekran değişmez. Cihazda python3 gerekir. Ajan: `/api/control/tty/read|send|close` (SSH bağlantısı panel kapanınca ya da 30 sn kullanılmayınca kapanır).
- Cihaz Kontrol kartı kompakt: sıcaklık · çalışma süresi (bilgi renginde) tek satır; işlemci / bellek / depolama yüzde + kullanılan/toplam; son okuma saati düğmelerle aynı satırda. AĞ bölümü kart başına açılır/kapanır, araç çubuğundaki "Ağ ayrıntıları" hepsini birden değiştirir.
- Durum kareleri iki grupta: HİZMETLER (SW, WEB, TUI, CRON) ve SİSTEM (LOGIN, HDMI, USB). Durum arka plan rengiyle: yeşil çalışıyor, gri durmuş, soluk bordo kurulu değil, sarı uyarı (ör. açılışta etkin ama durmuş / geçici), kırmızı hata; ayrıntı ipucunda. USB listesi USB karesinin ipucunda. SerialWorker kurulu değilse "yok" olarak ayırt edilir.
- SW, WEB, TUI ve CRON karelerine tıklanarak servis kalıcı olarak açılır / kapatılır (onay sorulur; SerialWorker kapatılırken veri gönderilmeyeceği ayrıca uyarılır). LOGIN karesi raspi-config otomatik girişini değiştirir (B1/B2 konsol, B3/B4 masaüstü), kartta "yeniden başlatma gerekli" uyarısı kalır. Sonuç gerçek son duruma göre raporlanır, ardından kart yenilenir. Ajan: yeni aç / kapat işlemleri ve WPF ile aynı durum okuması (SW/WEB/TUI açılış ayarı, LOGIN).
- Disk ve RAM doluluğu: %90 ve üstü sarı, %95 ve üstü kırmızı + ⚠; disk dolmak üzereyse ipucunda ne yapılacağı yazar.
- GENEL KONTROL çubuğu yalnız simge: Otomatik yenile, İsimleri gizle ve Ağ ayrıntıları açık / kapalı simge düğmesi (açıkken vurgulu, ipucu durumu da yazar); Cihaz | Hasta, toplu SerialWorker yeniden başlatma ve toplu yeniden başlatma simge.
- Ping Kontrol: "Tüm odaları daralt / genişlet" düğmesi.
- YBDB Odalar: odalar ve yataklar tabloları yoğun bakıma (bölüm) göre gruplu, başlıklar tıklanarak katlanır; "Tüm yoğun bakımları daralt / genişlet" düğmesi. Açık/kapalı durumu yenilemede korunur.
- Cihaz Güncelleme listesi: işaret grubuna "Yalnız hatalıları işaretle" simge düğmesi. DURUM ya da VERSİYON sütununda hata olanlar (Hata, SSH yok, SSH bağlanamadı) işaretlenir, diğerlerinin işareti kalkar; hatalı cihaz yoksa pasif.

## 0.23.1 — 2026-11-13
- Cihaz Güncelleme listesi: YATAK ID, wlan0 ve eth0 (ve IP) hücrelerine çift tıklayınca düzenleme kutusu açılmıyordu. Her tıklama tabloyu yeniden çizdiği için çift tıklama olayı eski hücreye gidiyordu; düzenleme artık ikinci tıklamada başlıyor.

## 0.23.0 — 2026-11-11
- Cihaz Güncelleme → swtui: swtui arka planda tmux içinde çalıştığı için, cihazda tmux yoksa swtui'den önce `updateFiles\tmux\*.deb` paketlerinden çevrimdışı kurulur. Kuruluysa dokunulmaz; paketlerden yalnızca cihazda kurulu olmayanlar kurulur (kütüphaneler eski sürüme düşmez). Ayrı bir tmux seçeneği yoktur.
- swtui kurulumundan sonra `swtui --durum` okunur: arka planda çalışmıyorsa artık yeşil "kuruldu" yerine sarı uyarı gösterilir.

## 0.22.3 — 2026-11-11
- Cihaz Güncelleme: "Tümünü işaretle" / "Temizle" bağlantıları, diğer araç düğmeleriyle aynı boyda tek çerçeveli ikon grubuna dönüştü; yapılacak iş yoksa (hepsi işaretli / hiçbiri işaretli değil) ilgili düğme soluk ve devre dışı.

## 0.22.2 — 2026-11-11
- Cihaz Güncelleme: 1150–1500 px genişlikteki ekranlarda cihaz listesi kartı sağdaki Oturum / Güncellemeler panelinin altına taşıyordu; tablo artık kendi içinde kayar.
- YBDB → Cihazlar → Toplu ekle: dar ekranda (≤1400 px) alanlar yan yana ve içeriğe göre genişlikte; Adi alanı 15 harflik ada göre açılır, sağ alt köşeden elle daraltılıp genişletilebilir.
- YBDB Odalar: oda ve yatak kartları her zaman aynı yükseklikte; filtreler dar ekranda iki satıra inse de alt kenarlar hizalı, tablolar kalan alanı doldurur.
