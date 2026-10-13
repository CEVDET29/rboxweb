// YERLEŞİK HL7 cihaz profilleri: WPF RboxTools Modules/Hl7/hl7-profiles.default.json ile aynı içerik (oradan kopyalanır;
// profil değişince bu dosyayı yeniden üretin). Kullanıcının kendi profilleri ajandan gelir (/api/hl7/profiles):
// aynı id'li profil yerleşik olanın yerine geçer.
export default {
  "version": 2,
  "aciklama": "YERLEŞİK HL7 cihaz profilleri (başvuru içindir; uygulama her açılışta bu dosyayı yeniden yazar, değişiklikleriniz kaybolur). Bir profili değiştirmek için hl7-profiles.json dosyasındaki profiles listesine kopyalayın: aynı id'li profil yerleşik olanın yerine geçer. Her profil bir cihaz ailesini tanır (match) ve cihazın kendi ölçüm kodlarını ekranda kullanılan ortak adlara çevirir (map). match boşsa profil 'genel' sayılır: cihaz tanınmazsa kullanılır. Eşleşme büyük/küçük harf duyarsızdır ve içerik araması yapar. map satırında 'code' OBX-3.1, 'text' OBX-3.2 alanıdır; ikisi de yazılırsa ikisi birden aranır. group + part (S/D/M) basınç ölçümlerini tek sütunda 'S/D (O)' olarak birleştirir. hide: true ölçümü gizler. invalidValues: bu değerler 'ölçüm yok' sayılır. devices: model (OBX-18.2) ve isteğe bağlı name (PV1-3.10 cihaz / konum kodu içinde aranır) → ekranda görünen cihaz türü. values: kodlu değerlerin (MNDRY_ON gibi) Türkçe karşılığı. Dosyayı değiştirdikten sonra uygulamayı yeniden başlatın.",
  "profiles": [
    {
      "id": "eretna",
      "name": "Eretna Vitascope 190",
      "aciklama": "LOINC kodları (8867-4 gibi) ve metin adları. Aynı kod farklı kanallarda kullanıldığı için (8479-8: NIBP / IBP1 / IBP2) eşleme metne göre yapılır. Eski yazılım (2003 örneği) üç basınç kanalını aynı metinle, farklı kodlarla yollar (84xx / 82xx / 83xx): Basınç 1-2-3. Yatak PV1 yerine PID-34.2'de (^4), hasta no PID-2'de, hasta tipi PID-35'te, boy ^ kilo PID-36'da.",
      "match": {
        "sender": [
          "Eretna"
        ]
      },
      "fields": {
        "bed": "PID-34.2",
        "patientId": "PID-2",
        "extra": [
          {
            "field": "PID-35",
            "label": "Hasta tipi"
          },
          {
            "field": "PID-36.1",
            "label": "Boy (m)"
          },
          {
            "field": "PID-36.2",
            "label": "Kilo (kg)"
          }
        ]
      },
      "invalidValues": [],
      "map": [
        {
          "code": "8867-4",
          "name": "Kalp hızı",
          "short": "HR"
        },
        {
          "code": "8877-4",
          "name": "SpO₂",
          "short": "SpO₂"
        },
        {
          "code": "9279-1",
          "name": "Solunum hızı",
          "short": "RR"
        },
        {
          "code": "8887-4",
          "name": "Solunum hızı",
          "short": "RR"
        },
        {
          "code": "8890-4",
          "name": "CO₂",
          "short": "CO₂"
        },
        {
          "code": "1234-6",
          "name": "Ritim türü",
          "short": "Ritim"
        },
        {
          "text": "NIBP SYSTOLIC",
          "name": "NIBP sistolik",
          "short": "NIBP-S",
          "group": "NIBP",
          "part": "S"
        },
        {
          "text": "NIBP DIASTOLIC",
          "name": "NIBP diyastolik",
          "short": "NIBP-D",
          "group": "NIBP",
          "part": "D"
        },
        {
          "text": "NIBP MEAN",
          "name": "NIBP ortalama",
          "short": "NIBP-M",
          "group": "NIBP",
          "part": "M"
        },
        {
          "text": "IBP1 SYSTOLIC",
          "name": "IBP1 sistolik",
          "short": "IBP1-S",
          "group": "IBP1",
          "part": "S"
        },
        {
          "text": "IBP1 DIASTOLIC",
          "name": "IBP1 diyastolik",
          "short": "IBP1-D",
          "group": "IBP1",
          "part": "D"
        },
        {
          "text": "IBP1 MEAN",
          "name": "IBP1 ortalama",
          "short": "IBP1-M",
          "group": "IBP1",
          "part": "M"
        },
        {
          "text": "IBP2 SYSTOLIC",
          "name": "IBP2 sistolik",
          "short": "IBP2-S",
          "group": "IBP2",
          "part": "S"
        },
        {
          "text": "IBP2 DIASTOLIC",
          "name": "IBP2 diyastolik",
          "short": "IBP2-D",
          "group": "IBP2",
          "part": "D"
        },
        {
          "text": "IBP2 MEAN",
          "name": "IBP2 ortalama",
          "short": "IBP2-M",
          "group": "IBP2",
          "part": "M"
        },
        {
          "code": "8479-8",
          "text": "INTRAVASCULAR SYSTOLIC:PRES:",
          "name": "Basınç 1 sistolik",
          "short": "P1-S",
          "group": "P1",
          "part": "S"
        },
        {
          "code": "8462-4",
          "text": "INTRAVASCULAR DIASTOLIC:PRES:",
          "name": "Basınç 1 diyastolik",
          "short": "P1-D",
          "group": "P1",
          "part": "D"
        },
        {
          "code": "8478-0",
          "text": "INTRAVASCULAR MEAN:PRES:",
          "name": "Basınç 1 ortalama",
          "short": "P1-M",
          "group": "P1",
          "part": "M"
        },
        {
          "code": "8279-8",
          "text": "INTRAVASCULAR SYSTOLIC:PRES:",
          "name": "Basınç 2 sistolik",
          "short": "P2-S",
          "group": "P2",
          "part": "S"
        },
        {
          "code": "8262-4",
          "text": "INTRAVASCULAR DIASTOLIC:PRES:",
          "name": "Basınç 2 diyastolik",
          "short": "P2-D",
          "group": "P2",
          "part": "D"
        },
        {
          "code": "8278-0",
          "text": "INTRAVASCULAR MEAN:PRES:",
          "name": "Basınç 2 ortalama",
          "short": "P2-M",
          "group": "P2",
          "part": "M"
        },
        {
          "code": "8379-8",
          "text": "INTRAVASCULAR SYSTOLIC:PRES:",
          "name": "Basınç 3 sistolik",
          "short": "P3-S",
          "group": "P3",
          "part": "S"
        },
        {
          "code": "8362-4",
          "text": "INTRAVASCULAR DIASTOLIC:PRES:",
          "name": "Basınç 3 diyastolik",
          "short": "P3-D",
          "group": "P3",
          "part": "D"
        },
        {
          "code": "8378-0",
          "text": "INTRAVASCULAR MEAN:PRES:",
          "name": "Basınç 3 ortalama",
          "short": "P3-M",
          "group": "P3",
          "part": "M"
        },
        {
          "text": "TEMPERATURE 1",
          "name": "Sıcaklık 1",
          "short": "T1"
        },
        {
          "text": "TEMPERATURE 1::",
          "name": "Sıcaklık 1",
          "short": "T1"
        },
        {
          "text": "TEMPERATURE 2",
          "name": "Sıcaklık 2",
          "short": "T2"
        },
        {
          "text": "TEMPERATURE 2::",
          "name": "Sıcaklık 2",
          "short": "T2"
        }
      ]
    },
    {
      "id": "nihon-kohden",
      "name": "Nihon Kohden",
      "aciklama": "Üreticiye özel kodlar (009000 NIBP SYS gibi). BSM-3562 örneğine göre.",
      "match": {
        "sender": [
          "NIHON KOHDEN"
        ]
      },
      "invalidValues": [],
      "map": [
        {
          "code": "007000",
          "name": "SpO₂",
          "short": "SpO₂"
        },
        {
          "code": "007001",
          "name": "Nabız (SpO₂)",
          "short": "PR"
        },
        {
          "code": "072007",
          "name": "Nabız (rPR)",
          "short": "rPR"
        },
        {
          "code": "009000",
          "name": "NIBP sistolik",
          "short": "NIBP-S",
          "group": "NIBP",
          "part": "S"
        },
        {
          "code": "009001",
          "name": "NIBP diyastolik",
          "short": "NIBP-D",
          "group": "NIBP",
          "part": "D"
        },
        {
          "code": "009002",
          "name": "NIBP ortalama",
          "short": "NIBP-M",
          "group": "NIBP",
          "part": "M"
        },
        {
          "code": "027000",
          "name": "Sıcaklık 1",
          "short": "T1"
        },
        {
          "code": "028000",
          "name": "Sıcaklık 2",
          "short": "T2"
        }
      ]
    },
    {
      "id": "comen",
      "name": "Comen ND12",
      "aciklama": "MLLP çerçeveli. Ölçümler MDIL sisteminde (OBX-3.3) ve kısa kodlarla (110 = HR). -100 / -10000 'ölçüm yok' anlamına gelir. Hasta demografisi (2006-2010) gizlenir.",
      "match": {
        "obxSystem": [
          "MDIL"
        ]
      },
      "invalidValues": [
        "-100",
        "-10000"
      ],
      "map": [
        {
          "code": "110",
          "name": "Kalp hızı",
          "short": "HR"
        },
        {
          "code": "151",
          "name": "Nabız (SpO₂)",
          "short": "PR"
        },
        {
          "code": "150",
          "name": "SpO₂",
          "short": "SpO₂"
        },
        {
          "code": "111",
          "name": "Solunum hızı",
          "short": "RR"
        },
        {
          "code": "115",
          "name": "PVC",
          "short": "PVC"
        },
        {
          "code": "112",
          "name": "ST I",
          "short": "ST-I"
        },
        {
          "code": "113",
          "name": "ST II",
          "short": "ST-II"
        },
        {
          "code": "114",
          "name": "ST III",
          "short": "ST-III"
        },
        {
          "code": "128",
          "name": "ST aVF",
          "short": "ST-aVF"
        },
        {
          "code": "127",
          "name": "ST aVL",
          "short": "ST-aVL"
        },
        {
          "code": "126",
          "name": "ST aVR",
          "short": "ST-aVR"
        },
        {
          "code": "120",
          "name": "ST V1",
          "short": "ST-V1"
        },
        {
          "code": "121",
          "name": "ST V2",
          "short": "ST-V2"
        },
        {
          "code": "122",
          "name": "ST V3",
          "short": "ST-V3"
        },
        {
          "code": "123",
          "name": "ST V4",
          "short": "ST-V4"
        },
        {
          "code": "124",
          "name": "ST V5",
          "short": "ST-V5"
        },
        {
          "code": "125",
          "name": "ST V6",
          "short": "ST-V6"
        },
        {
          "code": "201",
          "name": "Arter sistolik",
          "short": "ART-S",
          "group": "ART",
          "part": "S"
        },
        {
          "code": "202",
          "name": "Arter diyastolik",
          "short": "ART-D",
          "group": "ART",
          "part": "D"
        },
        {
          "code": "203",
          "name": "Arter ortalama",
          "short": "ART-M",
          "group": "ART",
          "part": "M"
        },
        {
          "code": "2006",
          "hide": true
        },
        {
          "code": "2007",
          "hide": true
        },
        {
          "code": "2008",
          "hide": true
        },
        {
          "code": "2009",
          "hide": true
        },
        {
          "code": "2010",
          "hide": true
        }
      ]
    },
    {
      "id": "mindray",
      "name": "Mindray (eGateway)",
      "aciklama": "Beneview ve BIG_DIPPER (bebek) monitörleri. Basınç ve SpO₂ kodları MDC olduğu için genel eşleme yeterli; burada yalnızca MNDRY'ye özel ECG ölçümlerinin adları var. Adlar tahmindir; gerekirse değiştirin.",
      "match": {
        "sender": [
          "MINDRAY"
        ]
      },
      "invalidValues": [],
      "map": [
        {
          "code": "581",
          "name": "R-on-T PVC hızı",
          "short": "R-on-T"
        },
        {
          "code": "580",
          "name": "Kaçırılan atım hızı",
          "short": "Kaçırılan"
        },
        {
          "code": "579",
          "name": "PVC kompleks hızı",
          "short": "PVC-CPLT"
        },
        {
          "code": "352",
          "name": "VPB hızı",
          "short": "VPB"
        },
        {
          "code": "108",
          "name": "Duraklama hızı",
          "short": "Duraklama"
        },
        {
          "code": "148216",
          "name": "SV atımları",
          "short": "SV"
        },
        {
          "code": "300",
          "name": "Pacer yakalamama hızı",
          "short": "Pace yakalamama"
        },
        {
          "code": "301",
          "name": "Pacer çalışmama hızı",
          "short": "Pace çalışmama"
        },
        {
          "code": "838",
          "name": "Cihaz adı",
          "short": "Cihaz"
        },
        {
          "code": "747",
          "name": "Cihaz kimliği",
          "short": "Cihaz kimliği"
        },
        {
          "code": "988",
          "name": "Yuva no",
          "short": "Yuva"
        },
        {
          "code": "1021",
          "name": "İlaç kimliği",
          "short": "İlaç no"
        },
        {
          "code": "933",
          "name": "TCI hedef konsantrasyon",
          "short": "TCI hedef"
        },
        {
          "code": "932",
          "name": "TCI uyanma konsantrasyonu",
          "short": "TCI uyanma"
        },
        {
          "code": "936",
          "name": "TCI indüksiyon süresi",
          "short": "TCI indüksiyon"
        },
        {
          "code": "937",
          "name": "TCI uyanma süresi",
          "short": "TCI uyanma süresi"
        },
        {
          "code": "938",
          "name": "Trend grafiği süresi",
          "short": "Trend süresi"
        },
        {
          "code": "311",
          "name": "İdeal kilo",
          "short": "İdeal kg"
        },
        {
          "code": "179",
          "name": "Zorunlu solunum sayısı",
          "short": "fmand"
        },
        {
          "code": "20028",
          "name": "Apne solunum sayısı (ayar)",
          "short": "fapne ayar"
        },
        {
          "code": "183",
          "name": "Solunum işi",
          "short": "WOB"
        },
        {
          "code": "20026",
          "name": "Ekspiratuar tetik (ayar)",
          "short": "Eksp. tetik"
        },
        {
          "code": "189",
          "name": "Ekspiratuar zaman sabiti",
          "short": "RCeksp"
        },
        {
          "code": "565",
          "name": "Kaçak yüzdesi",
          "short": "Kaçak %"
        },
        {
          "code": "20034",
          "name": "Aralıklı PEEP farkı (ayar)",
          "short": "ΔPEEP ayar"
        },
        {
          "code": "20032",
          "name": "İç çekme aralığı (ayar)",
          "short": "Sigh aralığı"
        },
        {
          "code": "20113",
          "name": "Apne kontrol tipi",
          "short": "Apne tipi"
        },
        {
          "code": "20112",
          "name": "Ekspirasyon tipi",
          "short": "Eksp. tipi"
        },
        {
          "code": "31038",
          "name": "Ventilasyon tipi",
          "short": "Vent. tipi"
        },
        {
          "code": "20110",
          "name": "IntelliCycle",
          "short": "IntelliCycle"
        },
        {
          "code": "20103",
          "name": "Asist",
          "short": "Asist"
        },
        {
          "code": "30002",
          "name": "Cihaz mod durumu",
          "short": "Mod durumu"
        }
      ],
      "devices": [
        {
          "model": "BIG_DIPPER",
          "type": "Hasta başı monitör"
        },
        {
          "model": "Beneview",
          "type": "Hasta başı monitör"
        },
        {
          "model": "SV300",
          "type": "Ventilatör"
        },
        {
          "model": "SV600",
          "type": "Ventilatör"
        },
        {
          "model": "SV800",
          "type": "Ventilatör"
        },
        {
          "model": "Pump",
          "name": "PERF",
          "type": "Perfüzör"
        },
        {
          "model": "Pump",
          "name": "SYR",
          "type": "Perfüzör"
        },
        {
          "model": "Pump",
          "type": "İnfüzyon pompası"
        }
      ],
      "values": {
        "MNDRY_INFUSION_STATUS_RUNNING": "Çalışıyor",
        "MNDRY_INFUSION_STATUS_PAUSED": "Duraklatıldı",
        "MNDRY_INFUSION_STATUS_STOPPED": "Durduruldu",
        "MNDRY_VENT_MODE_CPAP_PLUS_PS": "CPAP + PS",
        "MNDRY_VENT_MODE_PACV": "PACV",
        "MNDRY_VENT_MODE_VCV": "VCV",
        "MNDRY_VENT_MODE_PCV": "PCV",
        "MNDRY_VENT_MODE_SIMV_VC": "SIMV-VC",
        "MNDRY_VENT_MODE_SIMV_PC": "SIMV-PC",
        "MNDRY_ON": "Açık",
        "MNDRY_OFF": "Kapalı",
        "MNDRY_APNEA_CONTROL_TYPE_PRESSURE": "Basınç",
        "MNDRY_APNEA_CONTROL_TYPE_VOLUME": "Hacim",
        "MNDRY_EXP_TYPE_NON_AUTO": "Otomatik değil",
        "MNDRY_EXP_TYPE_AUTO": "Otomatik",
        "MNDRY_EVT_VENTILATION_TYPE_INTUBE": "Entübe",
        "MNDRY_EVT_VENTILATION_TYPE_NIV": "Noninvaziv",
        "MNDRY_EVT_STAT_MODE_NORMAL": "Normal"
      }
    },
    {
      "id": "genel",
      "name": "Genel (MDC)",
      "aciklama": "Cihaz tanınmadığında kullanılır. IEEE 11073 (MDC_...) adları uygulamanın yerleşik sözlüğünden gelir (GE, Mindray, Philips vb.).",
      "match": null,
      "invalidValues": [],
      "map": []
    }
  ]
};
