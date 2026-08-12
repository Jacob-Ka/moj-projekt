require('dotenv').config();
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

// ============== SIATKA BEZPIECZEŃSTWA - SERWER NIGDY SIĘ NIE ZATRZYMUJE ==============
// Bez tego, jeden nieoczekiwany błąd (np. dziwna odpowiedź strony konkurencji,
// zerwane połączenie z internetem w trakcie zapytania) mógłby zatrzymać CAŁY
// serwer, wymagając ręcznego restartu. Zamiast tego - logujemy błąd i działamy dalej.
process.on('unhandledRejection', (blad) => {
    console.error('⚠️  Nieobsłużony błąd (serwer działa dalej):', blad);
});
process.on('uncaughtException', (blad) => {
    console.error('⚠️  Nieoczekiwany błąd (serwer działa dalej):', blad);
});

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = 'claude-sonnet-5';
const SESSION_SECRET = process.env.SESSION_SECRET || 'zmien-ten-sekret-w-produkcji-na-cos-losowego';

// ============== SZYFROWANIE KLUCZY API SKLEPU (AES-256-GCM) ==============
// Klucze API sklepu (Consumer Key/Secret WooCommerce, token dostępu Shopify)
// NIGDY nie są zapisywane jawnym tekstem w bazie - są szyfrowane tym kluczem
// przed zapisem i odszyfrowywane dopiero tuż przed użyciem do realnego
// zapytania do sklepu. UWAGA: to jest SZYFROWANIE (odwracalne), nie
// haszowanie (nieodwracalne) - w przeciwieństwie do haseł użytkowników, te
// klucze MUSZĄ dać się odczytać z powrotem, żeby w ogóle połączyć się ze
// sklepem klienta. scryptSync zamienia ENCRYPTION_KEY (dowolnej długości) na
// dokładnie 32 bajty wymagane przez AES-256, niezależnie od tego, co ktoś
// wpisze w .env.
const ENCRYPTION_KEY = crypto.scryptSync(
    process.env.ENCRYPTION_KEY || 'zmien-ten-klucz-w-produkcji-na-cos-losowego-32b',
    'priceai-cloud-salt', 32
);

function zaszyfrujSekret(tekstJawny) {
    if (!tekstJawny) return tekstJawny;
    const iv = crypto.randomBytes(12); // 12 bajtów - standard dla GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    const zaszyfrowane = Buffer.concat([cipher.update(String(tekstJawny), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Format zapisu: enc:<iv>:<tag>:<dane> (wszystko base64) - prefiks "enc:"
    // pozwala odróżnić już zaszyfrowane wartości od ewentualnych starych,
    // jawnych wpisów sprzed tej zmiany (patrz odszyfrujSekret niżej).
    return `enc:${iv.toString('base64')}:${tag.toString('base64')}:${zaszyfrowane.toString('base64')}`;
}

function odszyfrujSekret(wartosc) {
    if (!wartosc) return wartosc;
    if (!wartosc.startsWith('enc:')) return wartosc; // stary, jawny wpis sprzed migracji na szyfrowanie - zwracamy bez zmian
    try {
        const [, ivB64, tagB64, danaB64] = wartosc.split(':');
        const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, Buffer.from(ivB64, 'base64'));
        decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
        const odszyfrowane = Buffer.concat([decipher.update(Buffer.from(danaB64, 'base64')), decipher.final()]);
        return odszyfrowane.toString('utf8');
    } catch (e) {
        console.error('⚠️  Nie udało się odszyfrować sekretu (zły ENCRYPTION_KEY?):', e.message);
        return null;
    }
}

// ============== LIMITY ZAPYTAŃ (rate limiting) ==============
const OGOLNY_LIMIT_ZAPYTAN = parseInt(process.env.OGOLNY_LIMIT_ZAPYTAN || '120', 10);
const ogolneLiczniki = new Map();

function limitOgolny(req, res, next) {
    const ip = req.ip;
    const teraz = Date.now();
    const wpis = ogolneLiczniki.get(ip);
    if (!wpis || teraz > wpis.resetCzas) {
        ogolneLiczniki.set(ip, { liczba: 1, resetCzas: teraz + 60 * 1000 });
        return next();
    }
    if (wpis.liczba >= OGOLNY_LIMIT_ZAPYTAN) {
        return res.status(429).json({ success: false, error: 'Zbyt wiele zapytań. Spróbuj ponownie za chwilę.' });
    }
    wpis.liczba++;
    next();
}

const AI_LIMIT_NA_GODZINE = parseInt(process.env.AI_LIMIT_NA_GODZINE || '20', 10);
const aiLiczniki = new Map();

function limitAI(req, res, next) {
    const ip = req.ip;
    const teraz = Date.now();
    const wpis = aiLiczniki.get(ip);
    if (!wpis || teraz > wpis.resetCzas) {
        aiLiczniki.set(ip, { liczba: 1, resetCzas: teraz + 60 * 60 * 1000 });
        return next();
    }
    if (wpis.liczba >= AI_LIMIT_NA_GODZINE) {
        const minutyDoResetu = Math.ceil((wpis.resetCzas - teraz) / 60000);
        return res.status(429).json({
            success: false,
            error: `Osiągnięto limit ${AI_LIMIT_NA_GODZINE} sugestii AI na godzinę z tego adresu. Spróbuj ponownie za ${minutyDoResetu} min.`
        });
    }
    wpis.liczba++;
    next();
}

const DZIENNY_LIMIT_AI = parseInt(process.env.DZIENNY_LIMIT_AI || '300', 10);
let dziennyLicznikAI = { liczba: 0, dzien: new Date().toDateString() };

// Osobny, oddzielny limit dla Asystenta Pomocy - żeby pytania typu "jak to
// działa?" nie zużywały płatnej puli tokenów przeznaczonej na sugestie cenowe.
const ASYSTENT_LIMIT_NA_GODZINE = parseInt(process.env.ASYSTENT_LIMIT_NA_GODZINE || '15', 10);
const asystentLiczniki = new Map();

function limitAsystenta(req, res, next) {
    const ip = req.ip;
    const teraz = Date.now();
    const wpis = asystentLiczniki.get(ip);
    if (!wpis || teraz > wpis.resetCzas) {
        asystentLiczniki.set(ip, { liczba: 1, resetCzas: teraz + 60 * 60 * 1000 });
        return next();
    }
    if (wpis.liczba >= ASYSTENT_LIMIT_NA_GODZINE) {
        const minutyDoResetu = Math.ceil((wpis.resetCzas - teraz) / 60000);
        return res.status(429).json({
            success: false,
            error: `Osiągnięto limit ${ASYSTENT_LIMIT_NA_GODZINE} pytań do asystenta na godzinę. Spróbuj ponownie za ${minutyDoResetu} min.`
        });
    }
    wpis.liczba++;
    next();
}

// Osobny, niższy limit TYLKO dla automatycznego wyszukiwania konkurencji -
// oprócz kosztu AI, ten endpoint robi też płatne zapytanie do Serper i
// realnie wchodzi na zewnętrzną stronę do weryfikacji ceny. Ogólny limit AI
// (20/h) i tak by to ograniczył, ale osobny, niższy limit chroni budżet
// Serper niezależnie od tego, ile tokenów AI komuś jeszcze zostało.
const AUTO_WYSZUKIWANIE_LIMIT_NA_GODZINE = parseInt(process.env.AUTO_WYSZUKIWANIE_LIMIT_NA_GODZINE || '10', 10);
const autoWyszukiwanieLiczniki = new Map();

function limitAutoWyszukiwania(req, res, next) {
    const ip = req.ip;
    const teraz = Date.now();
    const wpis = autoWyszukiwanieLiczniki.get(ip);
    if (!wpis || teraz > wpis.resetCzas) {
        autoWyszukiwanieLiczniki.set(ip, { liczba: 1, resetCzas: teraz + 60 * 60 * 1000 });
        return next();
    }
    if (wpis.liczba >= AUTO_WYSZUKIWANIE_LIMIT_NA_GODZINE) {
        const minutyDoResetu = Math.ceil((wpis.resetCzas - teraz) / 60000);
        return res.status(429).json({
            success: false,
            error: `Osiągnięto limit ${AUTO_WYSZUKIWANIE_LIMIT_NA_GODZINE} automatycznych wyszukiwań konkurencji na godzinę. Spróbuj ponownie za ${minutyDoResetu} min.`
        });
    }
    wpis.liczba++;
    next();
}

function sprawdzDziennyLimit(req, res, next) {
    const dzisiaj = new Date().toDateString();
    if (dziennyLicznikAI.dzien !== dzisiaj) dziennyLicznikAI = { liczba: 0, dzien: dzisiaj };
    if (dziennyLicznikAI.liczba >= DZIENNY_LIMIT_AI) {
        return res.status(429).json({
            success: false,
            error: `Osiągnięto dzienny limit ${DZIENNY_LIMIT_AI} sugestii AI dla całej aplikacji. Limit resetuje się o północy.`
        });
    }
    dziennyLicznikAI.liczba++;
    next();
}

app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
// Serwuje pliki front-endu (index.html, script.js, landing.html, i18n.js
// itd.) bezpośrednio z tego samego serwera - jeden proces, jeden adres,
// zamiast osobnego Live Server na innym porcie. Dzięki temu front-end i
// backend są zawsze na TYM SAMYM origin (np. https://twoja-domena.up.railway.app),
// więc zapytania API mogą używać ścieżek względnych (/api/...) zamiast
// sztywno wpisanego adresu - lokalnie i po wdrożeniu działa identycznie, bez
// zmiany kodu.
app.use(express.static(__dirname));
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { sameSite: 'lax', secure: false } // brak maxAge = sesja wygasa przy zamknięciu przeglądarki
}));
app.use('/api', limitOgolny);

// Ścieżka do bazy danych - konfigurowalna zmienną DB_PATH (np. na Railway
// wskazuje się tam ścieżkę do trwałego dysku/Volume, żeby dane przetrwały
// redeploy). Lokalnie domyślnie w tym samym folderze co server.js - wcześniej
// był to folder JEDEN POZIOM WYŻEJ (obejście problemu z Live Server), ale to
// nie ma sensu na hostingu (folder poza aplikacją może w ogóle nie istnieć
// albo nie być zapisywalny) - jeśli lokalnie przeszkadza Ci to z Live
// Serverem, użyj zmiennej DB_PATH zamiast zmieniać to na sztywno w kodzie.
const db = new sqlite3.Database(process.env.DB_PATH || './baza_global.db', (err) => {
    if (err) console.error('Błąd bazy:', err.message);
    else console.log('Połączono z globalną bazą SQLite.');
});

// Pomocnicze wersje async/await dla operacji na bazie (używane w harmonogramie
// automatycznym, gdzie trzeba wykonywać kroki jeden po drugim: najpierw
// odśwież ceny konkurencji, potem dopiero licz sugestie AI).
function dbAllAsync(sql, params) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
    });
}
function dbGetAsync(sql, params) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
}
function dbRunAsync(sql, params) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
    });
}

// ============== UŻYTKOWNICY / KONTA ==============
// CAŁY blok tworzenia tabel i migracji (poniżej) jest opakowany w
// db.serialize() - bez tego sterownik sqlite3 NIE gwarantuje kolejności
// wykonania kolejnych db.run(). Migracje (ALTER TABLE/UPDATE) zależą od
// tego, że odpowiednia tabela już istnieje - bez serialize() zdarzało się,
// że migracja startowała, zanim CREATE TABLE zdążyło się wykonać, co dawało
// "SQLITE_ERROR: no such table" mimo poprawnego kodu.
// Pula darmowych tokenów AI i limit produktów - jeden wiersz na każdego
// użytkownika/gościa DEMO (user_id obejmuje oba przypadki). Nowe konto
// dostaje 50 darmowych analiz AI i limit 10 produktów, dopóki nie przejdzie
// na plan Pro (system planów płatnych jeszcze nie istnieje - to miejsce
// przygotowane pod jego przyszłe dopięcie).
const DOMYSLNE_TOKENY_AI = parseInt(process.env.DOMYSLNE_TOKENY_AI || '50', 10);
const DOMYSLNY_LIMIT_PRODUKTOW = parseInt(process.env.DOMYSLNY_LIMIT_PRODUKTOW || '10', 10);

const LIMITY_PLANOW = {
    DEMO: {
        tokeny: parseInt(process.env.DEMO_TOKENY_AI || '20', 10),
        produkty: parseInt(process.env.DEMO_LIMIT_PRODUKTOW || '10', 10),
        cena_mc: 0, cena_rok: 0
    },
    FREE: {
        tokeny: parseInt(process.env.FREE_TOKENY_AI || String(DOMYSLNE_TOKENY_AI), 10),
        produkty: parseInt(process.env.FREE_LIMIT_PRODUKTOW || String(DOMYSLNY_LIMIT_PRODUKTOW), 10),
        cena_mc: 0, cena_rok: 0
    },
    // Od tego miejsca w dół: tokeny = produkty * 30 dni. To NIE jest
    // przypadek - to formuła gwarantująca, że klient może codziennie, przez
    // CAŁY miesiąc, automatyzować sugestie AI dla WSZYSTKICH swoich
    // produktów, nawet w najgorszym możliwym scenariuszu (zero trafień w
    // cache 24h, wszystko liczone przez AI, żaden produkt w trybie
    // regułowym). W praktyce klient prawie zawsze zużyje mniej (cache +
    // tryb regułowy), więc to jest bezpieczny górny limit, nie średnia.
    // Ceny liczone tak, żeby nawet w NAJGORSZYM realnym scenariuszu zużycia
    // (pełny limit tokenów wykorzystany co miesiąc, sporo kosztowniejszego
    // auto-wyszukiwania konkurencji, zero trafień w cache) zostawała zdrowa
    // marża rzędu ~2,5-3x ponad realny koszt API Anthropic (Claude Sonnet 5,
    // $2/$10 za milion tokenów wej./wyj., kurs ~3,73 zł/$, stan na 08.2026).
    // Starter/Pro mają bezpieczny margines nawet bez przeliczeń; Business/
    // Scale/Enterprise zostały podniesione, bo przy starych cenach realny
    // koszt AI w najgorszym przypadku mógł PRZEKROCZYĆ cenę dla klienta.
    STARTER: {
        tokeny: parseInt(process.env.STARTER_TOKENY_AI || '1500', 10), // 50 produktów * 30 dni
        produkty: parseInt(process.env.STARTER_LIMIT_PRODUKTOW || '50', 10),
        cena_mc: 49, cena_rok: 490
    },
    PRO: {
        tokeny: parseInt(process.env.PRO_TOKENY_AI || '9000', 10), // 300 produktów * 30 dni
        produkty: parseInt(process.env.PRO_LIMIT_PRODUKTOW || '300', 10),
        cena_mc: 299, cena_rok: 2990
    },
    BUSINESS: {
        tokeny: parseInt(process.env.BUSINESS_TOKENY_AI || '45000', 10), // 1500 produktów * 30 dni
        produkty: parseInt(process.env.BUSINESS_LIMIT_PRODUKTOW || '1500', 10),
        cena_mc: 1490, cena_rok: 14900
    },
    SCALE: {
        tokeny: parseInt(process.env.SCALE_TOKENY_AI || '150000', 10), // 5000 produktów * 30 dni
        produkty: parseInt(process.env.SCALE_LIMIT_PRODUKTOW || '5000', 10),
        cena_mc: 4900, cena_rok: 49000
    },
    ENTERPRISE: {
        tokeny: parseInt(process.env.ENTERPRISE_TOKENY_AI || '300000', 10), // 10000 produktów * 30 dni
        produkty: parseInt(process.env.ENTERPRISE_LIMIT_PRODUKTOW || '10000', 10),
        cena_mc: 9900, cena_rok: 99000
    }
};
const PLANY_PLATNE = ['STARTER', 'PRO', 'BUSINESS', 'SCALE', 'ENTERPRISE']; // plany mozliwe do "kupienia" (na razie testowo, bez realnej platnosci

// CAŁY blok tworzenia tabel i migracji (poniżej) jest opakowany w
// db.serialize() - bez tego sterownik sqlite3 NIE gwarantuje kolejności
// wykonania kolejnych db.run(). Migracje (ALTER TABLE/UPDATE) zależą od
// tego, że odpowiednia tabela już istnieje - bez serialize() zdarzało się,
// że migracja startowała, zanim CREATE TABLE zdążyło się wykonać, co dawało
// "SQLITE_ERROR: no such table" mimo poprawnego kodu. WAŻNE: w tym bloku
// mają być WYŁĄCZNIE wywołania db.run() - żadnych deklaracji const/function
// używanych gdzie indziej w pliku, bo takie deklaracje byłyby widoczne
// tylko lokalnie w tym callbacku (function-scoping), a nie globalnie.
db.serialize(() => {
db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    haslo_hash TEXT,
    utworzono TEXT
)`);

db.run(`CREATE TABLE IF NOT EXISTS limity_uzytkownika (
    user_id TEXT PRIMARY KEY,
    tokeny_ai INTEGER,
    limit_produktow INTEGER,
    plan TEXT DEFAULT 'FREE'
)`);

db.run(`CREATE TABLE IF NOT EXISTS globalne_produkty (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    nazwa TEXT,
    ean TEXT,
    waluta TEXT,
    twoja_cena TEXT,
    url_konkurencja TEXT,
    cena_konkurencji TEXT,
    sugerowana_cena TEXT,
    rekomendacja TEXT,
    data TEXT,
    ai_sprawdzona_cena_konkurencji TEXT,
    ai_ostatnio_sprawdzono TEXT,
    woo_produkt_id INTEGER,
    kraj TEXT
)`);

db.run(`CREATE TABLE IF NOT EXISTS konfiguracja (
    user_id TEXT PRIMARY KEY,
    store_url TEXT,
    consumer_key TEXT,
    consumer_secret TEXT,
    waluta TEXT,
    rynek TEXT,
    auto_reprice_time TEXT,
    daily_auto_sync INTEGER,
    zapisano TEXT
)`);

db.run(`CREATE TABLE IF NOT EXISTS historia_zmian_cen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    produkt_id INTEGER,
    stara_cena TEXT,
    nowa_cena TEXT,
    zrodlo TEXT,
    data TEXT
)`);

db.run(`CREATE TABLE IF NOT EXISTS zamowienia (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    numer TEXT,
    klient TEXT,
    data TEXT,
    wartosc TEXT,
    waluta TEXT,
    status TEXT
)`);

db.run(`CREATE TABLE IF NOT EXISTS magazyn (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    nazwa TEXT,
    sku TEXT,
    ilosc INTEGER,
    magazyn_nazwa TEXT
)`);

// Cache wyników wyszukiwania konkurencji na poziomie EAN/nazwy + kraju -
// WSPÓLNY dla wszystkich użytkowników (nie per-user), bo jeśli dwóch różnych
// klientów ma ten sam produkt (ten sam EAN), nie ma sensu płacić za
// wyszukiwanie Serper dwa razy w ciągu jednej doby dla identycznego zapytania.
// AI dopasowanie i tak liczy się osobno dla każdego (bo zależy od Twojej
// własnej ceny), tu cache'ujemy tylko surowe, kosztowne wyniki wyszukiwania.
db.run(`CREATE TABLE IF NOT EXISTS cache_wyszukiwan_konkurencji (
    klucz TEXT PRIMARY KEY,
    oferty_json TEXT,
    zapisano TEXT
)`);

// Historia cen konkurencji - każda cena, którą system uznał za wystarczająco
// pewną, żeby ją zapisać (ręczne dodanie linku + pobranie, albo potwierdzenie
// automatycznie znalezionej oferty), trafia tutaj z pełnym kontekstem. To
// pozwala z czasem zobaczyć, jak faktycznie zmienia się cena danego
// konkurenta, a nie tylko znać jego "aktualną" cenę.
db.run(`CREATE TABLE IF NOT EXISTS historia_cen_konkurencji (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    produkt_id INTEGER,
    cena TEXT,
    sklep TEXT,
    link TEXT,
    zrodlo TEXT,
    zweryfikowano INTEGER DEFAULT 0,
    data TEXT
)`);

// Pamięć strategii ekstrakcji ceny per DOMENA (nie per URL) - wspólna dla
// wszystkich użytkowników. Gdy raz ustalimy, że dla danej domeny cena
// znajduje się np. w mikrodanych, a nie w JSON-LD, zapamiętujemy to i przy
// kolejnych zapytaniach do TEJ SAMEJ domeny próbujemy najpierw sprawdzonej
// strategii, zamiast zawsze zaczynać od zera według sztywnego priorytetu.
db.run(`CREATE TABLE IF NOT EXISTS strategia_ekstrakcji_domeny (
    domena TEXT PRIMARY KEY,
    strategia TEXT,
    zapisano TEXT
)`);

// Kolejka przebiegów harmonogramu - jeden wiersz = jedno "uruchomienie
// automatycznego cenowania" dla jednego klienta. WAŻNE dla wielu klientów
// naraz (multi-tenant): bez tej kolejki, jeśli wielu klientów ma ten sam
// czas auto-repricingu (np. 6:00), system odpalał WSZYSTKICH jednocześnie,
// bez żadnego limitu - realnie zabijając limity API (Serper/SerpApi/
// Anthropic) i obciążając serwer. Teraz przebiegi czekają w kolejce i są
// przetwarzane z limitem współbieżności (patrz MAX_ROWNOLEGLYCH_PRZEBIEGOW).
db.run(`CREATE TABLE IF NOT EXISTS przebiegi_harmonogramu (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    status TEXT DEFAULT 'oczekuje',
    utworzono TEXT,
    rozpoczeto TEXT,
    zakonczono TEXT,
    produktow_lacznie INTEGER DEFAULT 0,
    produktow_przetworzonych INTEGER DEFAULT 0,
    blad TEXT
)`);

// Powiadomienia - żeby nie trzeba było ręcznie przeglądać całej tabeli
// produktów w poszukiwaniu problemów. System sam zgłasza tu zdarzenia
// wymagające uwagi (cena poniżej Floor Price, podsumowanie harmonogramu,
// kończące się tokeny AI).
db.run(`CREATE TABLE IF NOT EXISTS powiadomienia (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    typ TEXT,
    tresc TEXT,
    produkt_id INTEGER,
    przeczytane INTEGER DEFAULT 0,
    data TEXT
)`);

// ============== MIGRACJE (dodawanie kolumn do baz utworzonych wcześniejszą wersją) ==============
// SQLite nie ma "ADD COLUMN IF NOT EXISTS" - próbujemy dodać kolumnę i po
// prostu ignorujemy błąd "duplicate column", jeśli kolumna już istnieje.
// auto_pricing: czy DANY produkt bierze udział w automatycznym auto-pricingu
// (harmonogram + przełącznik przy produkcie). Domyślnie włączone (1), żeby
// zachowanie dla istniejących produktów się nie zmieniło.
db.run(`ALTER TABLE globalne_produkty ADD COLUMN auto_pricing INTEGER DEFAULT 1`, (err) => {
    if (err && !/duplicate column/i.test(err.message)) console.error('Migracja auto_pricing:', err.message);
});
// global_auto_pricing: ostatnia wartość globalnego przełącznika w panelu
// konfiguracji - używana jako domyślna wartość auto_pricing dla nowo
// importowanych/dodawanych produktów.
db.run(`ALTER TABLE konfiguracja ADD COLUMN global_auto_pricing INTEGER DEFAULT 1`, (err) => {
    if (err && !/duplicate column/i.test(err.message)) console.error('Migracja global_auto_pricing:', err.message);
});
// Naprawa danych: literalny tekst "AUTO" nie powinien być zapisany jako kod
// waluty PRODUKTU (to psuje porównanie cen konkurencji - system szukał ofert
// w USD zamiast PLN). Jednorazowo naprawiamy już zaimportowane produkty -
// bezpieczne do uruchamiania przy każdym starcie serwera (no-op, gdy nic do
// naprawy). Konfiguracja integracji (wybór użytkownika "Auto-Detekcja") NIE
// jest tu ruszana - to osobne pole, które steruje przyszłymi importami.
db.run(`UPDATE globalne_produkty SET waluta = 'PLN' WHERE waluta = 'AUTO' OR waluta IS NULL OR waluta = ''`, (err) => {
    if (err) console.error('Migracja waluty AUTO -> PLN:', err.message);
});
// tryb_cenowy: sposób wyliczania sugestii cenowej - 'AI' (domyślnie, jak
// dotychczas, pełna analiza modelem językowym) albo prosta, darmowa reguła
// matematyczna (patrz obliczCeneRegulowa) nie wymagająca w ogóle wywołania AI.
db.run(`ALTER TABLE konfiguracja ADD COLUMN tryb_cenowy TEXT DEFAULT 'AI'`, (err) => {
    if (err && !/duplicate column/i.test(err.message)) console.error('Migracja tryb_cenowy:', err.message);
});
db.run(`ALTER TABLE konfiguracja ADD COLUMN wartosc_reguly REAL DEFAULT 5`, (err) => {
    if (err && !/duplicate column/i.test(err.message)) console.error('Migracja wartosc_reguly:', err.message);
});
// onboarding_zakonczony: czy nowy użytkownik przeszedł już (albo pominął)
// kreator pierwszego uruchomienia - żeby pokazać go tylko raz.
db.run(`ALTER TABLE limity_uzytkownika ADD COLUMN onboarding_zakonczony INTEGER DEFAULT 0`, (err) => {
    if (err && !/duplicate column/i.test(err.message)) console.error('Migracja onboarding_zakonczony:', err.message);
});
// ceny_zawieraja_vat / stawka_vat: porównywanie Twojej ceny z ceną konkurencji
// bez wiedzy, czy obie są w tej samej bazie (brutto vs netto) daje fałszywe
// wyniki - 20-23% różnicy wygląda jak "sensowna" cena konkurencji, ale to
// tylko VAT. Domyślnie zakładamy brutto (najczęstsza praktyka B2C).
db.run(`ALTER TABLE konfiguracja ADD COLUMN ceny_zawieraja_vat INTEGER DEFAULT 1`, (err) => {
    if (err && !/duplicate column/i.test(err.message)) console.error('Migracja ceny_zawieraja_vat:', err.message);
});
db.run(`ALTER TABLE konfiguracja ADD COLUMN stawka_vat REAL DEFAULT NULL`, (err) => {
    if (err && !/duplicate column/i.test(err.message)) console.error('Migracja stawka_vat:', err.message);
});
// cena_bazowa: PRAWDZIWA cena bazowa - ustawiana RAZ przy dodaniu/imporcie
// produktu i NIGDY nie nadpisywana przez AI/regułę/harmonogram. Wcześniej
// "Reset do Bazowych" pobierał cenę wprost z WooCommerce, ale ponieważ
// akceptacja sugestii AI nadpisuje TĘ SAMĄ cenę w sklepie, reset przywracał
// w kółko tę samą, już zmienioną wartość - w praktyce nic nie robił. To pole
// jest niezależną "kopią zapasową" ceny sprzed jakiejkolwiek automatyzacji.
db.run(`ALTER TABLE globalne_produkty ADD COLUMN cena_bazowa TEXT`, (err) => {
    if (err && !/duplicate column/i.test(err.message)) console.error('Migracja cena_bazowa:', err.message);
});
// Uzupełnienie dla PRODUKTÓW ISTNIEJĄCYCH JUŻ W BAZIE (dodanych zanim to pole
// istniało): jeśli produkt ma jakąkolwiek zapisaną historię zmian cen,
// najstarszy wpis (stara_cena) to najlepsze dostępne przybliżenie prawdziwej
// ceny bazowej. Dla produktów bez żadnej historii jedyne, co możemy zrobić,
// to przyjąć ich AKTUALNĄ cenę jako punkt odniesienia na przyszłość - nie da
// się już odzyskać ceny sprzed zmian, których nie zapisaliśmy.
db.run(`
    UPDATE globalne_produkty
    SET cena_bazowa = COALESCE(
        (SELECT stara_cena FROM historia_zmian_cen WHERE produkt_id = globalne_produkty.id ORDER BY id ASC LIMIT 1),
        twoja_cena
    )
    WHERE cena_bazowa IS NULL
`, (err) => {
    if (err) console.error('Migracja uzupełnienia cena_bazowa:', err.message);
});
// wszystkie_kandydaci_json: pełna lista ofert, które przeszły filtry i
// zostały pokazane AI do wyboru - żeby było widać, dlaczego wybrano akurat
// TĘ ofertę, a nie inną (np. tańszą, ale mniej pewnie dopasowaną). Bez tego
// widać było tylko finalny wynik, bez kontekstu "co jeszcze system znalazł".
db.run(`ALTER TABLE historia_cen_konkurencji ADD COLUMN wszystkie_kandydaci_json TEXT`, (err) => {
    if (err && !/duplicate column/i.test(err.message)) console.error('Migracja wszystkie_kandydaci_json:', err.message);
});
// platforma: który system e-commerce klient podłączył - 'woocommerce' (jak
// dotychczas), 'shopify' (druga obsługiwana platforma), albo 'csv' (dowolny
// inny system - klient ręcznie importuje/eksportuje CSV, bez automatycznej
// integracji API). Domyślnie 'woocommerce', żeby istniejące konta się nie zmieniły.
db.run(`ALTER TABLE konfiguracja ADD COLUMN platforma TEXT DEFAULT 'woocommerce'`, (err) => {
    if (err && !/duplicate column/i.test(err.message)) console.error('Migracja platforma:', err.message);
});
// floor_price_procent (konfiguracja): domyślny procent Floor Price dla
// WSZYSTKICH produktów użytkownika, jeśli konkretny produkt nie ma
// ustawionego własnego. Wcześniej było to sztywne 75% wpisane w kod - błąd,
// bo różne produkty mają różne marże (np. koszt 100, cena 120 -> Floor Price
// na 75% z 120 = 90, czyli PONIŻEJ kosztu zakupu = strata).
db.run(`ALTER TABLE konfiguracja ADD COLUMN floor_price_procent REAL DEFAULT 75`, (err) => {
    if (err && !/duplicate column/i.test(err.message)) console.error('Migracja floor_price_procent (konfiguracja):', err.message);
});
// floor_price_procent (globalne_produkty): opcjonalne NADPISANIE dla
// KONKRETNEGO produktu - NULL oznacza "użyj globalnego ustawienia z
// konfiguracji". To pozwala mieć różny Floor Price dla różnych produktów w
// tym samym koncie (np. jeden produkt ma wąską marżę, inny szeroką).
db.run(`ALTER TABLE globalne_produkty ADD COLUMN floor_price_procent REAL DEFAULT NULL`, (err) => {
    if (err && !/duplicate column/i.test(err.message)) console.error('Migracja floor_price_procent (produkt):', err.message);
});
// zewnetrzny_id: identyfikator zamówienia w WooCommerce/Shopify - potrzebny,
// żeby powtórna synchronizacja NIE dublowała tych samych zamówień za każdym
// razem. NULL dla zamówień dodanych ręcznie (te nie mają odpowiednika w
// żadnym zewnętrznym systemie).
db.run(`ALTER TABLE zamowienia ADD COLUMN zewnetrzny_id TEXT`, (err) => {
    if (err && !/duplicate column/i.test(err.message)) console.error('Migracja zewnetrzny_id:', err.message);
});
// regulamin_zaakceptowano: DATA i CZAS akceptacji Regulaminu/Polityki
// Prywatności przy rejestracji - to nie tylko flaga true/false, tylko dowód
// zgody z konkretnym znacznikiem czasu, przydatny prawnie w razie sporu.
db.run(`ALTER TABLE users ADD COLUMN regulamin_zaakceptowano TEXT`, (err) => {
    if (err && !/duplicate column/i.test(err.message)) console.error('Migracja regulamin_zaakceptowano:', err.message);
});
}); // koniec db.serialize() dla tworzenia tabel i migracji

// UWAGA: ta funkcja MUSI być zdefiniowana na poziomie globalnym pliku (poza
// db.serialize() powyżej) - jest wywoływana z endpointów rejestracji,
// logowania i trybu DEMO, które wykonują się długo po starcie serwera.
// Umieszczenie jej WEWNĄTRZ callbacku db.serialize() sprawiłoby, że byłaby
// widoczna tylko lokalnie w tamtym bloku (function-scoping), a nie globalnie.
function utworzLimityDlaUzytkownika(userId, planTyp, callback) {
    if (typeof planTyp === 'function') { callback = planTyp; planTyp = 'FREE'; }
    const limity = LIMITY_PLANOW[planTyp] || LIMITY_PLANOW.FREE;
    db.run(
        `INSERT OR IGNORE INTO limity_uzytkownika (user_id, tokeny_ai, limit_produktow, plan) VALUES (?, ?, ?, ?)`,
        [userId, limity.tokeny, limity.produkty, planTyp],
        callback || (() => {})
    );
}

// ============== POWIADOMIENIA ==============
// Centralny sposób zgłaszania zdarzeń wymagających uwagi użytkownika - żeby
// nie trzeba było ręcznie przeglądać całej tabeli produktów. `typ` służy do
// prostego odsiewania duplikatów (np. nie zasypujemy tokenowym ostrzeżeniem
// przy każdym pojedynczym zapytaniu AI).
async function dodajPowiadomienie(userId, typ, tresc, produktId) {
    try {
        await dbRunAsync(
            `INSERT INTO powiadomienia (user_id, typ, tresc, produkt_id, przeczytane, data) VALUES (?, ?, ?, ?, 0, ?)`,
            [userId, typ, tresc, produktId || null, new Date().toLocaleString('pl-PL')]
        );
    } catch (e) { /* powiadomienie to funkcja pomocnicza - błąd zapisu nie może wywrócić głównej operacji */ }
}

// Niektóre powiadomienia (np. "kończą się tokeny") nie mają sensu przy
// każdym wystąpieniu - ta funkcja dodaje powiadomienie danego typu TYLKO
// jeśli nie ma już nieprzeczytanego powiadomienia tego samego typu z
// ostatnich 24h, żeby nie zasypywać użytkownika duplikatami.
async function dodajPowiadomienieZDeduplikacja(userId, typ, tresc, produktId) {
    try {
        const dzienTemu = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const istniejace = await dbAllAsync(
            `SELECT id, data FROM powiadomienia WHERE user_id = ? AND typ = ? AND przeczytane = 0 ORDER BY id DESC LIMIT 1`,
            [userId, typ]
        );
        if (istniejace && istniejace.length > 0) {
            // Proste porównanie - jeśli mamy jakiekolwiek nieprzeczytane tego typu, nie dubluj.
            return;
        }
        await dodajPowiadomienie(userId, typ, tresc, produktId);
    } catch (e) { /* nieblokujące */ }
}

app.get('/api/powiadomienia', wymagajSesji, (req, res) => {
    db.all(`SELECT * FROM powiadomienia WHERE user_id = ? ORDER BY id DESC LIMIT 50`, [req.session.userId], (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/powiadomienia/:id/przeczytane', wymagajSesji, (req, res) => {
    db.run(`UPDATE powiadomienia SET przeczytane = 1 WHERE id = ? AND user_id = ?`, [req.params.id, req.session.userId], (err) => {
        if (err) return res.status(500).json({ success: false, error: 'Błąd zapisu.' });
        res.json({ success: true });
    });
});

app.post('/api/powiadomienia/wszystkie-przeczytane', wymagajSesji, (req, res) => {
    db.run(`UPDATE powiadomienia SET przeczytane = 1 WHERE user_id = ?`, [req.session.userId], (err) => {
        if (err) return res.status(500).json({ success: false, error: 'Błąd zapisu.' });
        res.json({ success: true });
    });
});

// ============== AUTORYZACJA ==============
// Każdy zalogowany user ma user_id = String(id) z tabeli users.
// Każdy gość DEMO ma user_id = "guest_<losowy-identyfikator>" - dane są
// odizolowane od reszty i naturalnie "znikają" (nowa sesja = nowy gość),
// bo ciasteczko sesji nie ma maxAge (kończy się z zamknięciem przeglądarki).
function wymagajSesji(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({ success: false, error: 'Musisz się zalogować lub uruchomić DEMO.' });
    }
    next();
}

app.post('/api/register', async (req, res) => {
    const { email, haslo, akceptujeRegulamin } = req.body;
    if (!email || !haslo || haslo.length < 6) {
        return res.status(400).json({ success: false, error: 'Podaj email i hasło (min. 6 znaków).' });
    }
    if (!akceptujeRegulamin) {
        return res.status(400).json({ success: false, error: 'Musisz zaakceptować Regulamin oraz Politykę Prywatności, żeby założyć konto.' });
    }
    try {
        const hash = await bcrypt.hash(haslo, 10);
        db.run(
            `INSERT INTO users (email, haslo_hash, utworzono, regulamin_zaakceptowano) VALUES (?, ?, ?, ?)`,
            [email.toLowerCase().trim(), hash, new Date().toISOString(), new Date().toISOString()],
            function (err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) {
                        return res.status(400).json({ success: false, error: 'Ten email jest już zarejestrowany.' });
                    }
                    return res.status(500).json({ success: false, error: 'Błąd rejestracji.' });
                }
                req.session.userId = String(this.lastID);
                req.session.email = email;
                req.session.isGuest = false;
                utworzLimityDlaUzytkownika(req.session.userId, () => {
                    res.json({ success: true, email });
                });
            }
        );
    } catch (e) {
        res.status(500).json({ success: false, error: 'Błąd rejestracji.' });
    }
});

app.post('/api/login', (req, res) => {
    const { email, haslo } = req.body;
    if (!email || !haslo) return res.status(400).json({ success: false, error: 'Podaj email i hasło.' });

    db.get(`SELECT * FROM users WHERE email = ?`, [email.toLowerCase().trim()], async (err, user) => {
        if (err || !user) return res.status(401).json({ success: false, error: 'Nieprawidłowy email lub hasło.' });

        const pasuje = await bcrypt.compare(haslo, user.haslo_hash);
        if (!pasuje) return res.status(401).json({ success: false, error: 'Nieprawidłowy email lub hasło.' });

        req.session.userId = String(user.id);
        req.session.email = user.email;
        req.session.isGuest = false;
        utworzLimityDlaUzytkownika(req.session.userId, () => {
            res.json({ success: true, email: user.email });
        });
    });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

app.post('/api/demo/start', (req, res) => {
    const guestId = 'guest_' + crypto.randomUUID();
    req.session.userId = guestId;
    req.session.isGuest = true;
    req.session.email = null;

    utworzLimityDlaUzytkownika(guestId, 'DEMO');

    // Przykładowe dane demo - wyraźnie oznaczone jako przykładowe, widoczne
    // tylko w tej jednej, tymczasowej sesji gościa. To NIE są dane pretendujące
    // być prawdziwym sklepem - to ilustracja działania narzędzia dla kogoś, kto
    // jeszcze się nie zalogował.
    const stmt = db.prepare(
        `INSERT INTO globalne_produkty (user_id, nazwa, ean, waluta, twoja_cena, url_konkurencja, cena_konkurencji, sugerowana_cena, rekomendacja, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`
    );
    const dzis = new Date().toLocaleDateString('pl-PL');
    stmt.run(guestId, 'Przykładowy Rower Miejski (DEMO)', '0000000000001', 'PLN', '2400.00', '', '2350.00', dzis);
    stmt.run(guestId, 'Przykładowe Słuchawki Bezprzewodowe (DEMO)', '0000000000002', 'PLN', '249.00', '', '229.00', dzis);
    stmt.finalize();

    res.json({ success: true, demo: true });
});

app.get('/api/me', (req, res) => {
    if (!req.session.userId) return res.json({ zalogowany: false });
    const userId = req.session.userId;

    db.get(`SELECT * FROM limity_uzytkownika WHERE user_id = ?`, [userId], (err, limity) => {
        db.get(`SELECT COUNT(*) AS liczba FROM globalne_produkty WHERE user_id = ?`, [userId], (err2, wynikLiczby) => {
            const plan = limity ? limity.plan : 'FREE';
            res.json({
                zalogowany: true,
                email: req.session.email,
                demo: !!req.session.isGuest,
                tokeny_ai: limity ? limity.tokeny_ai : DOMYSLNE_TOKENY_AI,
                tokeny_ai_limit: limity ? (LIMITY_PLANOW[plan] ? LIMITY_PLANOW[plan].tokeny : limity.tokeny_ai) : DOMYSLNE_TOKENY_AI,
                limit_produktow: limity ? limity.limit_produktow : DOMYSLNY_LIMIT_PRODUKTOW,
                liczba_produktow: wynikLiczby ? wynikLiczby.liczba : 0,
                onboarding_zakonczony: limity ? !!limity.onboarding_zakonczony : false,
                plan
            });
        });
    });
});

// Oznacza kreator pierwszego uruchomienia jako zakończony (albo pominięty) -
// żeby nie pokazywał się przy każdym kolejnym logowaniu.
app.post('/api/onboarding/zakoncz', wymagajSesji, (req, res) => {
    db.run(`UPDATE limity_uzytkownika SET onboarding_zakonczony = 1 WHERE user_id = ?`, [req.session.userId], (err) => {
        if (err) return res.status(500).json({ success: false, error: 'Błąd zapisu.' });
        res.json({ success: true });
    });
});

// Zwraca cennik wszystkich planów (do wyświetlenia na stronie/w modalu wyboru planu).
app.get('/api/plany', (req, res) => {
    const wynik = {};
    PLANY_PLATNE.forEach(nazwa => { wynik[nazwa] = LIMITY_PLANOW[nazwa]; });
    res.json(wynik);
});

// Testowe "przejście na wybrany plan" - bez prawdziwej płatności, bo systemu
// płatności jeszcze nie ma. Dostępne tylko dla zarejestrowanych kont (nie DEMO),
// żeby przetestować jak zachowuje się aplikacja z różnymi limitami.
app.post('/api/plan/aktywuj', wymagajSesji, (req, res) => {
    if (req.session.isGuest) {
        return res.status(403).json({ success: false, error: 'Załóż prawdziwe konto, aby przetestować płatne plany.' });
    }
    const { plan } = req.body;
    if (!PLANY_PLATNE.includes(plan)) {
        return res.status(400).json({ success: false, error: 'Nieznany plan.' });
    }
    const limity = LIMITY_PLANOW[plan];
    db.run(
        `UPDATE limity_uzytkownika SET plan = ?, tokeny_ai = ?, limit_produktow = ? WHERE user_id = ?`,
        [plan, limity.tokeny, limity.produkty, req.session.userId],
        (err) => {
            if (err) return res.status(500).json({ success: false, error: 'Błąd aktywacji planu.' });
            res.json({ success: true, plan, tokeny_ai: limity.tokeny, limit_produktow: limity.produkty });
        }
    );
});

// ============== INTEGRACJA Z PRAWDZIWYM SKLEPEM (WooCommerce) ==============
// Wymaga klucza REST API wygenerowanego w panelu WooCommerce:
// WooCommerce -> Ustawienia -> Zaawansowane -> REST API -> Dodaj klucz
// (uprawnienia: przynajmniej "Odczyt"). Da to Consumer Key (ck_...) i
// Consumer Secret (cs_...).
//
// WAŻNE: WooCommerce wymaga POŁĄCZENIA SZYFROWANEGO (https://), żeby w ogóle
// zaakceptować autoryzację - przez zwykłe http:// traktuje zapytanie jako
// niezalogowanego gościa (błąd "cannot list resources"), nawet z poprawnymi
// kluczami. Dlatego adres sklepu MUSI zaczynać się od https://.
async function pobierzProduktyZWooCommerce(storeUrl, consumerKey, consumerSecret) {
    const bazowyUrl = storeUrl.trim().replace(/\/+$/, '');
    const url = `${bazowyUrl}/wp-json/wc/v3/products?per_page=100`;
    const authHeader = 'Basic ' + Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

    // Certyfikaty SSL na lokalnych domenach testowych (np. sklep.local z Local
    // by WP Engine) są zwykle samopodpisane, więc Node.js im domyślnie nie ufa.
    // To bezpieczne, tymczasowe ominięcie weryfikacji - WYŁĄCZNIE na czas tego
    // jednego zapytania i WYŁĄCZNIE dla domen kończących się na ".local".
    // Prawdziwe sklepy (prawdziwa domena, ważny certyfikat) nigdy tego nie dotyczy.
    let hostname = '';
    try { hostname = new URL(bazowyUrl).hostname; } catch (e) {}
    const jestDomenaLokalna = hostname.endsWith('.local');
    const poprzedniaWartoscTLS = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    if (jestDomenaLokalna) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    let res;
    try {
        res = await fetch(url, { headers: { Authorization: authHeader } });
    } catch (e) {
        throw new Error('Nie udało się połączyć z podanym adresem sklepu. Sprawdź czy adres jest poprawny (np. https://twojsklep.pl) i czy sklep jest uruchomiony.');
    } finally {
        if (jestDomenaLokalna) process.env.NODE_TLS_REJECT_UNAUTHORIZED = poprzedniaWartoscTLS;
    }

    if (!res.ok) {
        if (res.status === 401) throw new Error('Nieprawidłowy Consumer Key/Secret, albo sklep wymaga połączenia przez https:// (sprawdź adres sklepu).');
        if (res.status === 404) throw new Error('Nie znaleziono WooCommerce REST API pod tym adresem - sprawdź czy WooCommerce jest zainstalowane i adres sklepu jest poprawny.');
        const tekst = await res.text().catch(() => '');
        throw new Error(`WooCommerce API zwróciło błąd ${res.status}: ${tekst.slice(0, 200)}`);
    }

    const dane = await res.json();
    if (!Array.isArray(dane)) throw new Error('Nieoczekiwana odpowiedź z WooCommerce (spodziewano się listy produktów).');
    return dane;
}

// Wysyła nową cenę Z POWROTEM do prawdziwego sklepu WooCommerce - bez tego
// zaakceptowana cena zmieniałaby się tylko w naszej bazie, nie u realnych
// klientów w sklepie.
async function wyslijCeneDoWooCommerce(storeUrl, consumerKey, consumerSecret, wooProduktId, nowaCena) {
    const bazowyUrl = storeUrl.trim().replace(/\/+$/, '');
    const url = `${bazowyUrl}/wp-json/wc/v3/products/${wooProduktId}`;
    const authHeader = 'Basic ' + Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

    let hostname = '';
    try { hostname = new URL(bazowyUrl).hostname; } catch (e) {}
    const jestDomenaLokalna = hostname.endsWith('.local');
    const poprzedniaWartoscTLS = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    if (jestDomenaLokalna) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    let res;
    try {
        res = await fetch(url, {
            method: 'PUT',
            headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify({ regular_price: String(nowaCena) })
        });
    } catch (e) {
        throw new Error('Nie udało się połączyć ze sklepem, żeby wysłać nową cenę.');
    } finally {
        if (jestDomenaLokalna) process.env.NODE_TLS_REJECT_UNAUTHORIZED = poprzedniaWartoscTLS;
    }

    if (!res.ok) {
        const tekst = await res.text().catch(() => '');
        throw new Error(`WooCommerce odrzuciło aktualizację ceny (status ${res.status}): ${tekst.slice(0, 200)}`);
    }
    return true;
}

// Pomocnicza funkcja: wysyła nową cenę do sklepu TYLKO jeśli produkt jest
// realnie powiązany z WooCommerce (ma zapisane woo_produkt_id) i mamy zapisaną
// konfigurację połączenia. Dla produktów dodanych ręcznie (bez integracji)
// nic nie wysyła - nie ma dokąd.
async function wyslijCeneJesliPolaczony(userId, produkt, nowaCena) {
    if (!produkt.woo_produkt_id) return { wyslano: false };
    let konfiguracja;
    try {
        konfiguracja = await dbGetAsync(`SELECT platforma, store_url, consumer_key, consumer_secret FROM konfiguracja WHERE user_id = ?`, [userId]);
    } catch (e) { return { wyslano: false }; }
    if (!konfiguracja || !konfiguracja.store_url) return { wyslano: false };
    konfiguracja.consumer_key = odszyfrujSekret(konfiguracja.consumer_key);
    konfiguracja.consumer_secret = odszyfrujSekret(konfiguracja.consumer_secret);

    const platforma = konfiguracja.platforma || 'woocommerce';
    try {
        if (platforma === 'shopify') {
            if (!konfiguracja.consumer_secret) return { wyslano: false }; // token dostępu Shopify trzymany w consumer_secret
            await wyslijCeneDoShopify(konfiguracja.store_url, konfiguracja.consumer_secret, produkt.woo_produkt_id, nowaCena);
        } else if (platforma === 'csv') {
            return { wyslano: false }; // brak automatycznej integracji - klient sam eksportuje/importuje CSV
        } else {
            if (!konfiguracja.consumer_key || !konfiguracja.consumer_secret) return { wyslano: false };
            await wyslijCeneDoWooCommerce(konfiguracja.store_url, konfiguracja.consumer_key, konfiguracja.consumer_secret, produkt.woo_produkt_id, nowaCena);
        }
        return { wyslano: true };
    } catch (e) {
        console.error(`⚠️  Nie udało się wysłać ceny do sklepu (${platforma}) dla produktu ${produkt.id}:`, e.message);
        return { wyslano: false, blad: e.message };
    }
}

// ============== INTEGRACJA Z SHOPIFY (druga obsługiwana platforma) ==============
// Autoryzacja Shopify Admin API działa inaczej niż WooCommerce: zamiast pary
// Consumer Key/Secret, sklep generuje JEDEN token dostępu (Shopify Admin ->
// Ustawienia -> Aplikacje i kanały sprzedaży -> Twórz aplikację -> API Admin
// -> nadaj uprawnienia read_products/write_products). Żeby nie dokładać
// kolejnych kolumn w bazie tylko dla jednej platformy, reużywamy istniejące
// pola: store_url = domena sklepu (np. twoj-sklep.myshopify.com),
// consumer_secret = token dostępu. Pole consumer_key zostaje wtedy puste.
//
// WAŻNE - kształt zwracanych obiektów jest CELOWO identyczny jak w
// pobierzProduktyZWooCommerce (te same nazwy pól: id, name, price,
// regular_price, sku, manage_stock, stock_quantity) - dzięki temu cała reszta
// logiki importu (wykonajImportZPlatformy) działa dla obu platform bez
// żadnych rozgałęzień - różni się tylko SPOSÓB pobrania danych, nie to, co
// się z nimi później dzieje.
async function pobierzProduktyZShopify(storeUrl, accessToken) {
    const domena = storeUrl.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const url = `https://${domena}/admin/api/2024-01/products.json?limit=250`;
    let res;
    try {
        res = await fetch(url, { headers: { 'X-Shopify-Access-Token': accessToken } });
    } catch (e) {
        throw new Error('Nie udało się połączyć ze sklepem Shopify. Sprawdź czy domena jest poprawna (np. twoj-sklep.myshopify.com).');
    }
    if (!res.ok) {
        if (res.status === 401) throw new Error('Nieprawidłowy token dostępu Shopify Admin API.');
        if (res.status === 404) throw new Error('Nie znaleziono sklepu Shopify pod tym adresem.');
        const tekst = await res.text().catch(() => '');
        throw new Error(`Shopify API zwróciło błąd ${res.status}: ${tekst.slice(0, 200)}`);
    }
    const dane = await res.json();
    if (!Array.isArray(dane.products)) throw new Error('Nieoczekiwana odpowiedź z Shopify (spodziewano się listy produktów).');

    // Shopify grupuje warianty (rozmiar/kolor itd.) pod jednym produktem -
    // każdy wariant ma WŁASNĄ cenę i stan magazynowy, więc traktujemy każdy
    // wariant jako osobną pozycję w naszym systemie (identycznie jak
    // WooCommerce traktuje osobne warianty produktu).
    const splaszczone = [];
    for (const produkt of dane.products) {
        for (const wariant of (produkt.variants || [])) {
            splaszczone.push({
                id: wariant.id,
                name: (produkt.variants.length > 1 && wariant.title !== 'Default Title') ? `${produkt.title} (${wariant.title})` : produkt.title,
                price: wariant.price,
                regular_price: wariant.price,
                sku: wariant.sku || null,
                manage_stock: wariant.inventory_management === 'shopify',
                stock_quantity: wariant.inventory_quantity
            });
        }
    }
    return splaszczone;
}

async function wyslijCeneDoShopify(storeUrl, accessToken, wariantId, nowaCena) {
    const domena = storeUrl.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const url = `https://${domena}/admin/api/2024-01/variants/${wariantId}.json`;
    let res;
    try {
        res = await fetch(url, {
            method: 'PUT',
            headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ variant: { id: wariantId, price: String(nowaCena) } })
        });
    } catch (e) {
        throw new Error('Nie udało się połączyć ze sklepem Shopify, żeby wysłać nową cenę.');
    }
    if (!res.ok) {
        const tekst = await res.text().catch(() => '');
        throw new Error(`Shopify odrzuciło aktualizację ceny (status ${res.status}): ${tekst.slice(0, 200)}`);
    }
    return true;
}

async function pobierzWaluteSklepuShopify(storeUrl, accessToken) {
    try {
        const domena = storeUrl.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
        const res = await fetch(`https://${domena}/admin/api/2024-01/shop.json`, { headers: { 'X-Shopify-Access-Token': accessToken } });
        if (!res.ok) return null;
        const dane = await res.json();
        return dane?.shop?.currency ? String(dane.shop.currency).toUpperCase() : null;
    } catch (e) {
        return null;
    }
}

async function pobierzZamowieniaZShopify(storeUrl, accessToken) {
    const domena = storeUrl.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const url = `https://${domena}/admin/api/2024-01/orders.json?status=any&limit=250`;
    let res;
    try {
        res = await fetch(url, { headers: { 'X-Shopify-Access-Token': accessToken } });
    } catch (e) { return []; }
    if (!res.ok) return [];
    const dane = await res.json();
    return Array.isArray(dane.orders) ? dane.orders : [];
}

// ============== SYNCHRONIZACJA ZAMÓWIEŃ (wspólna dla WooCommerce i Shopify) ==============
// Wcześniej zakładka "Zamówienia" pokazywała WYŁĄCZNIE ręcznie dodane wpisy -
// zupełnie oddzielna, martwa ścieżka względem kafelków KPI (Sprzedaż/Zysk),
// które już liczą się z prawdziwych zamówień pobranych bezpośrednio ze
// sklepu (patrz obliczStatystykiOkresu). To była realna niespójność: klient
// widziałby prawdziwe liczby na górze i pustą tabelę zamówień pod spodem.
// Ta funkcja zapisuje TE SAME zamówienia do lokalnej tabeli `zamowienia`,
// żeby zakładka faktycznie pokazywała, co się dzieje w sklepie. Deduplikacja
// przez `zewnetrzny_id` - powtórna synchronizacja aktualizuje status
// istniejących wpisów, nie tworzy duplikatów.
async function synchronizujZamowienia(userId, platforma, storeUrl, consumerKey, consumerSecret) {
    if (platforma === 'csv') return { zaimportowano: 0, zaktualizowano: 0 }; // brak API - nic do zsynchronizowania

    const teraz = new Date();
    const miesiacTemu = new Date(teraz.getTime() - 30 * 24 * 60 * 60 * 1000);
    let zewnetrzneZamowienia = [];

    if (platforma === 'shopify') {
        const surowe = await pobierzZamowieniaZShopify(storeUrl, consumerSecret);
        zewnetrzneZamowienia = surowe.map(z => ({
            zewnetrzny_id: `shopify_${z.id}`,
            numer: z.name || `#${z.order_number}`,
            klient: z.customer ? `${z.customer.first_name || ''} ${z.customer.last_name || ''}`.trim() || z.email || 'Nieznany klient' : (z.email || 'Nieznany klient'),
            data: z.created_at ? new Date(z.created_at).toLocaleString('pl-PL') : teraz.toLocaleString('pl-PL'),
            wartosc: z.total_price || '0',
            waluta: z.currency || 'PLN',
            status: z.cancelled_at ? 'Anulowane' : (z.fulfillment_status === 'fulfilled' ? 'Wysłane' : (z.financial_status === 'paid' ? 'Opłacone' : 'Nowe'))
        }));
    } else {
        const surowe = await pobierzWszystkieZamowieniaWooCommerce(storeUrl, consumerKey, consumerSecret, miesiacTemu.toISOString());
        const mapaStatusow = { pending: 'Nowe', 'on-hold': 'Nowe', processing: 'Opłacone', completed: 'Zrealizowane', cancelled: 'Anulowane', refunded: 'Anulowane', failed: 'Anulowane' };
        zewnetrzneZamowienia = surowe.map(z => ({
            zewnetrzny_id: `woo_${z.id}`,
            numer: `#${z.number || z.id}`,
            klient: `${z.billing?.first_name || ''} ${z.billing?.last_name || ''}`.trim() || 'Nieznany klient',
            data: z.date_created ? new Date(z.date_created).toLocaleString('pl-PL') : teraz.toLocaleString('pl-PL'),
            wartosc: z.total || '0',
            waluta: z.currency || 'PLN',
            status: mapaStatusow[z.status] || 'Nowe'
        }));
    }

    const istniejace = await dbAllAsync(`SELECT id, zewnetrzny_id FROM zamowienia WHERE user_id = ? AND zewnetrzny_id IS NOT NULL`, [userId]);
    const istniejaceMapa = new Map((istniejace || []).map(z => [z.zewnetrzny_id, z.id]));

    let zaimportowano = 0;
    let zaktualizowano = 0;
    for (const z of zewnetrzneZamowienia) {
        const istniejacyId = istniejaceMapa.get(z.zewnetrzny_id);
        if (istniejacyId) {
            await dbRunAsync(`UPDATE zamowienia SET status = ?, wartosc = ? WHERE id = ?`, [z.status, z.wartosc, istniejacyId]);
            zaktualizowano++;
        } else {
            await dbRunAsync(
                `INSERT INTO zamowienia (user_id, numer, klient, data, wartosc, waluta, status, zewnetrzny_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, z.numer, z.klient, z.data, z.wartosc, z.waluta, z.status, z.zewnetrzny_id]
            );
            zaimportowano++;
        }
    }
    return { zaimportowano, zaktualizowano };
}

// Pobiera RZECZYWISTĄ walutę sklepu z ustawień WooCommerce - używane, gdy
// użytkownik wybrał "Auto-Detekcja" w panelu (wtedy NIE wolno zapisywać
// dosłownego tekstu "AUTO" jako kodu waluty produktu, bo to psuje każde
// dalsze porównanie cen i wyszukiwanie konkurencji).
async function pobierzWaluteSklepu(storeUrl, consumerKey, consumerSecret) {
    try {
        const bazowyUrl = storeUrl.trim().replace(/\/+$/, '');
        const url = `${bazowyUrl}/wp-json/wc/v3/settings/general/woocommerce_currency`;
        const authHeader = 'Basic ' + Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
        const res = await fetch(url, { headers: { Authorization: authHeader } });
        if (!res.ok) return null;
        const dane = await res.json();
        return dane && dane.value ? String(dane.value).toUpperCase() : null;
    } catch (e) {
        return null;
    }
}

// ============== VAT: WYKRYCIE BAZY CENY (BRUTTO/NETTO) ==============
// Porównywanie Twojej ceny z ceną konkurencji bez wiedzy, czy obie są w tej
// samej bazie, daje fałszywe wyniki - różnica dokładnie o stawkę VAT (np.
// 23%) wygląda jak zupełnie sensowna, prawdziwa różnica cenowa, a to tylko
// niespójność brutto/netto. Odczytujemy to wprost z ustawień WooCommerce,
// zamiast zgadywać.
async function pobierzUstawieniaVatSklepu(storeUrl, consumerKey, consumerSecret) {
    const bazowyUrl = storeUrl.trim().replace(/\/+$/, '');
    const authHeader = 'Basic ' + Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

    let zawieraVat = true; // domyślne założenie - najczęstsza praktyka B2C (ceny brutto widoczne dla klienta)
    try {
        const res = await fetch(`${bazowyUrl}/wp-json/wc/v3/settings/general/woocommerce_prices_include_tax`, { headers: { Authorization: authHeader } });
        if (res.ok) {
            const dane = await res.json();
            if (dane && dane.value) zawieraVat = dane.value === 'yes';
        }
    } catch (e) { /* zostajemy przy domyślnym założeniu */ }

    let stawka = null;
    try {
        const res = await fetch(`${bazowyUrl}/wp-json/wc/v3/taxes?per_page=5`, { headers: { Authorization: authHeader } });
        if (res.ok) {
            const stawki = await res.json();
            if (Array.isArray(stawki) && stawki.length > 0) {
                const standardowa = stawki.find(s => !s.name || /standard|podstawow/i.test(s.name)) || stawki[0];
                const parsed = parseFloat(standardowa.rate);
                if (!isNaN(parsed) && parsed > 0) stawka = parsed;
            }
        }
    } catch (e) { /* brak stawki - normalizacja po prostu się nie wykona */ }

    return { zawieraVat, stawka };
}

// Sprowadza cenę konkurencji do TEJ SAMEJ bazy, w jakiej trzymasz własne ceny.
// Zakładamy, że ceny konkurencji widoczne publicznie są brutto (tak pokazuje
// się ceny klientom) - jeśli Twoje własne ceny są netto, odejmujemy VAT od
// ceny konkurencji, żeby porównanie było uczciwe. Jeśli Twoje ceny SĄ brutto
// (zdecydowanie najczęstszy przypadek) - nic się nie zmienia, zero ryzyka
// zepsucia działającego już porównania.
function dostosujCeneKonkurencjiDoBazy(cenaKonkurencji, konfiguracja) {
    if (cenaKonkurencji === null || cenaKonkurencji === undefined || isNaN(cenaKonkurencji)) return cenaKonkurencji;
    if (!konfiguracja) return cenaKonkurencji;
    const zawieraVat = konfiguracja.ceny_zawieraja_vat !== 0;
    const stawka = konfiguracja.stawka_vat;
    if (zawieraVat || !stawka || stawka <= 0) return cenaKonkurencji;
    return cenaKonkurencji / (1 + stawka / 100);
}

// Zwraca KOPIĘ produktu z cena_konkurencji dostosowaną do bazy VAT
// użytkownika - do użycia WYŁĄCZNIE przy liczeniu sugestii (AI/reguła).
// Oryginalny obiekt `produkt` (i to, co zapisujemy do bazy jako
// ai_sprawdzona_cena_konkurencji) musi zostać nietknięty - to surowa cena
// konkurencji używana do wykrywania, czy coś się zmieniło od ostatniego
// sprawdzenia, nie wolno jej cicho przeliczać.
function produktZDostosowanaCenaKonkurencji(produkt, konfiguracja) {
    const kopia = { ...produkt };
    if (produkt.cena_konkurencji) {
        const oryginalna = parseFloat(produkt.cena_konkurencji);
        if (!isNaN(oryginalna)) {
            const dostosowana = dostosujCeneKonkurencjiDoBazy(oryginalna, konfiguracja);
            if (dostosowana !== oryginalna) kopia.cena_konkurencji = dostosowana.toFixed(2);
        }
    }
    // Rozwiązujemy Floor Price TERAZ (produkt -> konfiguracja -> 75%
    // domyślnie), żeby funkcje budujące prompt AI mogły po prostu odczytać
    // gotową, już rozstrzygniętą wartość, bez potrzeby osobnego przekazywania
    // im konfiguracji.
    kopia.floor_price_procent = obliczProcentFloorPrice(produkt, konfiguracja);
    return kopia;
}

// ============== AUTOMATYCZNA DETEKCJA KRAJU I WALUTY ==============
// Cel: nikt nie powinien musieć ręcznie wpisywać kraju/waluty, żeby
// wyszukiwanie konkurencji działało poprawnie. Kolejność źródeł (od
// najbardziej wiarygodnego): (1) jawne ustawienie na produkcie (użytkownik
// wie najlepiej), (2) ustawienia realnego sklepu e-commerce (WooCommerce),
// (3) geolokalizacja po adresie IP jako ostatni fallback, (4) sztywna
// wartość domyślna (PL/PLN), żeby funkcja NIGDY nie zwróciła pustki.

// Publiczny adres IP TEGO serwera - potrzebny, gdy detekcja odpalana jest w
// tle (harmonogram automatyczny), a nie w odpowiedzi na żądanie przeglądarki
// (wtedy nie mamy adresu IP klienta z requestu).
async function pobierzPublicznyIP() {
    try {
        const kontroler = new AbortController();
        const czas = setTimeout(() => kontroler.abort(), 4000);
        const res = await fetch('https://api.ipify.org?format=json', { signal: kontroler.signal });
        clearTimeout(czas);
        if (!res.ok) return null;
        const dane = await res.json();
        return dane.ip || null;
    } catch (e) {
        return null;
    }
}

// Darmowe, bezkluczowe API geolokalizacji IP (ip-api.com) - zwraca m.in.
// kod kraju ORAZ walutę używaną w tym kraju bezpośrednio, bez potrzeby
// osobnej tabeli mapującej kraj->waluta.
async function pobierzGeolokalizacjePoIP(ip) {
    if (!ip) return null;
    try {
        const kontroler = new AbortController();
        const czas = setTimeout(() => kontroler.abort(), 4000);
        const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,countryCode,currency`;
        const res = await fetch(url, { signal: kontroler.signal });
        clearTimeout(czas);
        if (!res.ok) return null;
        const dane = await res.json();
        if (dane.status !== 'success' || !dane.countryCode) return null;
        return { kraj: dane.countryCode.toLowerCase(), waluta: dane.currency ? String(dane.currency).toUpperCase() : null };
    } catch (e) {
        return null;
    }
}

function jestAdresemPrywatnym(ip) {
    if (!ip) return true;
    const czysty = ip.replace('::ffff:', '');
    return /^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\.|^::1$|^localhost$/i.test(czysty);
}

// Główna funkcja detekcji - zwraca { targetCountry, targetCurrency, zrodlo }.
// `req` jest opcjonalny - podaj go, gdy wywołanie dzieje się w kontekście
// żywego żądania HTTP (wtedy użyty zostanie adres IP klienta), pomiń przy
// wywołaniu w tle (np. z harmonogramu automatycznego) - wtedy funkcja sama
// ustali publiczny adres IP serwera.
async function detectStoreContext(userId, req) {
    // Krok 1: ustawienia realnego sklepu e-commerce (najbardziej wiarygodne,
    // bo to faktyczna konfiguracja biznesu, nie zgadywanie).
    try {
        const konfiguracja = await dbGetAsync(`SELECT store_url, consumer_key, consumer_secret FROM konfiguracja WHERE user_id = ?`, [userId]);
        if (konfiguracja) {
            konfiguracja.consumer_key = odszyfrujSekret(konfiguracja.consumer_key);
            konfiguracja.consumer_secret = odszyfrujSekret(konfiguracja.consumer_secret);
        }
        if (konfiguracja && konfiguracja.store_url && konfiguracja.consumer_key && konfiguracja.consumer_secret) {
            const waluta = await pobierzWaluteSklepu(konfiguracja.store_url, konfiguracja.consumer_key, konfiguracja.consumer_secret);
            if (waluta) {
                return { targetCountry: krajDlaWaluty(waluta), targetCurrency: waluta, zrodlo: 'sklep' };
            }
        }
    } catch (e) { /* przechodzimy do geolokalizacji po IP */ }

    // Krok 2: geolokalizacja po IP - IP klienta z żądania (jeśli jest i nie
    // jest adresem prywatnym/localhost), w przeciwnym razie publiczny IP
    // samego serwera.
    let ip = req?.ip || req?.headers?.['x-forwarded-for'] || null;
    if (Array.isArray(ip)) ip = ip[0];
    if (typeof ip === 'string' && ip.includes(',')) ip = ip.split(',')[0].trim();
    if (jestAdresemPrywatnym(ip)) ip = await pobierzPublicznyIP();

    if (ip) {
        const geo = await pobierzGeolokalizacjePoIP(ip);
        if (geo && geo.waluta) {
            return { targetCountry: geo.kraj, targetCurrency: geo.waluta, zrodlo: 'ip' };
        }
    }

    // Krok 3: ostateczny, sztywny fallback - funkcja nigdy nie zwraca pustki.
    return { targetCountry: 'pl', targetCurrency: 'PLN', zrodlo: 'domyslne' };
}

// Wspólna logika importu/synchronizacji z WooCommerce - używana zarówno przy
// pierwszym podłączeniu sklepu (import-oferty), jak i przy ręcznej
// "Szybkiej synchronizacji" (synchronizuj) - żeby nie duplikować kodu i żeby
// obie ścieżki zachowywały się identycznie.
// Uogólniona wersja - działa dla WooCommerce i Shopify (dispatch po
// `platforma`), reszta logiki (import/aktualizacja cen/synchronizacja
// magazynu) jest identyczna dla obu, bo obie funkcje pobierające produkty
// zwracają dane w TYM SAMYM kształcie (patrz komentarz przy
// pobierzProduktyZShopify). Dla `platforma === 'csv'` ta funkcja nie jest
// wywoływana wcale - tamta ścieżka ma osobne, dedykowane endpointy.
async function wykonajImportZPlatformy(userId, platforma, storeUrl, consumerKey, consumerSecret, walutaWybrana, autoPricingDomyslnie) {
    // "AUTO" to wybór użytkownika w panelu ("Auto-Detekcja"), nie prawdziwy
    // kod waluty - NIGDY nie zapisujemy go wprost do produktów, tylko
    // rozwiązujemy na realny kod (z ustawień sklepu, z fallbackiem na PLN).
    let waluta = walutaWybrana;
    if (!waluta || waluta === 'AUTO') {
        waluta = platforma === 'shopify'
            ? (await pobierzWaluteSklepuShopify(storeUrl, consumerSecret)) || 'PLN'
            : (await pobierzWaluteSklepu(storeUrl, consumerKey, consumerSecret)) || 'PLN';
    }

    const produktyZewnetrzne = platforma === 'shopify'
        ? await pobierzProduktyZShopify(storeUrl, consumerSecret)
        : await pobierzProduktyZWooCommerce(storeUrl, consumerKey, consumerSecret);

    const limity = await dbGetAsync(`SELECT limit_produktow FROM limity_uzytkownika WHERE user_id = ?`, [userId]);
    const limitProduktow = limity ? limity.limit_produktow : DOMYSLNY_LIMIT_PRODUKTOW;

    const istniejace = await dbAllAsync(`SELECT id, ean, twoja_cena FROM globalne_produkty WHERE user_id = ?`, [userId]);
    const istniejaceMapa = new Map((istniejace || []).map(p => [p.ean, p]));

    const przedrostekId = platforma === 'shopify' ? 'shopify_' : 'woo_';
    const nowe = produktyZewnetrzne.filter(p => !istniejaceMapa.has(p.sku || `${przedrostekId}${p.id}`));
    const miejsceDostepne = Math.max(0, limitProduktow - istniejaceMapa.size);
    const doImportu = nowe.slice(0, miejsceDostepne);

    const dzis = new Date().toLocaleDateString('pl-PL');
    const terazTekst = new Date().toLocaleString('pl-PL');
    let zaimportowano = 0;
    let zaktualizowanoCene = 0;

    for (const p of doImportu) {
        const cena = p.price || p.regular_price || '0';
        const ean = p.sku || `${przedrostekId}${p.id}`;
        await dbRunAsync(
            `INSERT INTO globalne_produkty (user_id, nazwa, ean, waluta, twoja_cena, cena_bazowa, url_konkurencja, cena_konkurencji, sugerowana_cena, rekomendacja, data, woo_produkt_id, auto_pricing)
             VALUES (?, ?, ?, ?, ?, ?, '', NULL, NULL, NULL, ?, ?, ?)`,
            [userId, p.name, ean, waluta || 'PLN', cena, cena, dzis, p.id, autoPricingDomyslnie ? 1 : 0]
        );
        zaimportowano++;
    }

    // Odśwież ceny produktów już wcześniej zaimportowanych, jeśli zmieniły się
    // w sklepie od ostatniej synchronizacji - inaczej "Szybka synchronizacja"
    // tylko dodawałaby nowe produkty, ignorując zmiany istniejących.
    for (const p of produktyZewnetrzne) {
        const ean = p.sku || `${przedrostekId}${p.id}`;
        const istniejacy = istniejaceMapa.get(ean);
        if (!istniejacy) continue;
        const nowaCena = String(p.price || p.regular_price || '0');
        if (nowaCena && nowaCena !== String(istniejacy.twoja_cena)) {
            await dbRunAsync(`UPDATE globalne_produkty SET twoja_cena = ? WHERE id = ?`, [nowaCena, istniejacy.id]);
            await dbRunAsync(
                `INSERT INTO historia_zmian_cen (user_id, produkt_id, stara_cena, nowa_cena, zrodlo, data) VALUES (?, ?, ?, ?, ?, ?)`,
                [userId, istniejacy.id, istniejacy.twoja_cena, nowaCena, 'Synchronizacja ze sklepem', terazTekst]
            );
            zaktualizowanoCene++;
        }
    }

    // Synchronizacja stanów magazynowych - obie platformy udostępniają je w
    // tym samym zapytaniu co produkty, więc nie potrzeba osobnej konfiguracji.
    // Produkty bez włączonego śledzenia stanu (manage_stock=false) pomijamy.
    const istniejaceSku = await dbAllAsync(`SELECT sku FROM magazyn WHERE user_id = ?`, [userId]);
    const istniejaceSkuSet = new Set((istniejaceSku || []).map(m => m.sku).filter(Boolean));
    let zaktualizowanoMagazyn = 0;

    for (const p of produktyZewnetrzne) {
        if (!p.manage_stock || p.stock_quantity === null || p.stock_quantity === undefined) continue;
        const sku = p.sku || `${przedrostekId}${p.id}`;
        if (istniejaceSkuSet.has(sku)) {
            await dbRunAsync(`UPDATE magazyn SET ilosc = ? WHERE user_id = ? AND sku = ?`, [p.stock_quantity, userId, sku]);
        } else {
            await dbRunAsync(
                `INSERT INTO magazyn (user_id, nazwa, sku, ilosc, magazyn_nazwa) VALUES (?, ?, ?, ?, ?)`,
                [userId, p.name, sku, p.stock_quantity, platforma === 'shopify' ? 'Shopify' : 'WooCommerce']
            );
        }
        zaktualizowanoMagazyn++;
    }

    // Zamówienia - żeby zakładka "Zamówienia" faktycznie pokazywała realne
    // dane, tak samo jak kafelki KPI. Nieblokujące: błąd synchronizacji
    // zamówień nie może zepsuć reszty importu (produktów/cen/magazynu).
    let zamowieniaWynik = { zaimportowano: 0, zaktualizowano: 0 };
    try {
        zamowieniaWynik = await synchronizujZamowienia(userId, platforma, storeUrl, consumerKey, consumerSecret);
    } catch (e) {
        console.log(`⚠️  Synchronizacja zamówień nie powiodła się: ${e.message}`);
    }

    return {
        znalezionych: produktyZewnetrzne.length,
        zaimportowano,
        zaktualizowanoCene,
        pominieto_limit: Math.max(0, nowe.length - doImportu.length),
        magazyn_zsynchronizowany: zaktualizowanoMagazyn,
        zamowienia_zaimportowano: zamowieniaWynik.zaimportowano,
        zamowienia_zaktualizowano: zamowieniaWynik.zaktualizowano
    };
}

app.post('/api/import-oferty', wymagajSesji, async (req, res) => {
    const { storeUrl, consumerKey, consumerSecret, waluta, rynek, autoRepriceTime, dailyAutoSync, globalAutoPricing, trybCenowy, wartoscReguly, platforma } = req.body;
    const userId = req.session.userId;
    const platformaWartosc = (platforma === 'shopify' || platforma === 'csv') ? platforma : 'woocommerce';

    if (platformaWartosc === 'csv') {
        return res.status(400).json({ success: false, error: 'Dla trybu "Inny system (CSV)" nie zapisuje się tutaj konfiguracji - użyj importu/eksportu CSV w zakładce Synchronizacja.' });
    }
    if (!storeUrl || (platformaWartosc === 'woocommerce' && (!consumerKey || !consumerSecret)) || (platformaWartosc === 'shopify' && !consumerSecret)) {
        return res.status(400).json({
            success: false,
            error: platformaWartosc === 'shopify'
                ? 'Podaj domenę sklepu Shopify i token dostępu Admin API.'
                : 'Podaj adres sklepu, Consumer Key i Consumer Secret.'
        });
    }

    const autoPricingWartosc = globalAutoPricing === false ? 0 : 1;
    const trybCenowyWartosc = (trybCenowy === 'PROCENT_PONIZEJ_KONKURENCJI' || trybCenowy === 'DOPASUJ_KONKURENCJE') ? trybCenowy : 'AI';
    const wartoscRegulyWartosc = (typeof wartoscReguly === 'number' && wartoscReguly > 0) ? wartoscReguly : 5;

    db.run(
        `INSERT INTO konfiguracja (user_id, platforma, store_url, consumer_key, consumer_secret, waluta, rynek, auto_reprice_time, daily_auto_sync, global_auto_pricing, tryb_cenowy, wartosc_reguly, zapisano)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
            platforma = excluded.platforma,
            store_url = excluded.store_url, consumer_key = excluded.consumer_key, consumer_secret = excluded.consumer_secret,
            waluta = excluded.waluta, rynek = excluded.rynek,
            auto_reprice_time = excluded.auto_reprice_time, daily_auto_sync = excluded.daily_auto_sync,
            global_auto_pricing = excluded.global_auto_pricing,
            tryb_cenowy = excluded.tryb_cenowy, wartosc_reguly = excluded.wartosc_reguly,
            zapisano = excluded.zapisano`,
        [userId, platformaWartosc, storeUrl, consumerKey ? zaszyfrujSekret(consumerKey) : '', zaszyfrujSekret(consumerSecret), waluta, rynek, autoRepriceTime, dailyAutoSync ? 1 : 0, autoPricingWartosc, trybCenowyWartosc, wartoscRegulyWartosc, new Date().toISOString()],
        async (err) => {
            if (err) return res.status(500).json({ success: false, error: 'Błąd zapisu konfiguracji.' });

            // Zastosuj globalny przełącznik Auto-pricing NATYCHMIAST do wszystkich
            // istniejących produktów użytkownika - to jest sens słowa "Globalny"
            // w nazwie tego przełącznika (inaczej działałby tylko na nowe produkty).
            try {
                await dbRunAsync(`UPDATE globalne_produkty SET auto_pricing = ? WHERE user_id = ?`, [autoPricingWartosc, userId]);
            } catch (e) { /* nieblokujące - kontynuuj mimo błędu */ }

            // Wykrywanie VAT działa na razie tylko dla WooCommerce (Shopify ma
            // inny model podatkowy - do dodania osobno, jeśli okaże się potrzebne).
            if (platformaWartosc === 'woocommerce') {
                try {
                    const vat = await pobierzUstawieniaVatSklepu(storeUrl, consumerKey, consumerSecret);
                    await dbRunAsync(`UPDATE konfiguracja SET ceny_zawieraja_vat = ?, stawka_vat = ? WHERE user_id = ?`, [vat.zawieraVat ? 1 : 0, vat.stawka, userId]);
                } catch (e) { /* nieblokujące - normalizacja VAT po prostu się nie wykona */ }
            }

            // Konfiguracja zapisana - teraz spróbuj realnie połączyć się ze sklepem i zaimportować produkty.
            try {
                const wynik = await wykonajImportZPlatformy(userId, platformaWartosc, storeUrl, consumerKey, consumerSecret, waluta, autoPricingWartosc === 1);
                const pominietoTxt = wynik.pominieto_limit > 0 ? ` (pominięto ${wynik.pominieto_limit} z powodu limitu planu)` : '';
                res.json({
                    success: true,
                    message: `Połączono ze sklepem. Zaimportowano ${wynik.zaimportowano} nowych produktów z ${wynik.znalezionych} znalezionych${pominietoTxt}, zsynchronizowano stan magazynowy dla ${wynik.magazyn_zsynchronizowany}, zaimportowano ${wynik.zamowienia_zaimportowano} zamówień.`,
                    polaczono: true,
                    ...wynik
                });
            } catch (e) {
                // Konfiguracja i tak jest zapisana - ale sam import się nie udał.
                res.json({ success: true, polaczono: false, message: `Konfiguracja zapisana, ale nie udało się połączyć ze sklepem: ${e.message}` });
            }
        }
    );
});

app.get('/api/konfiguracja', wymagajSesji, (req, res) => {
    db.get(`SELECT * FROM konfiguracja WHERE user_id = ?`, [req.session.userId], (err, row) => {
        if (row) {
            row.consumer_key = odszyfrujSekret(row.consumer_key);
            row.consumer_secret = odszyfrujSekret(row.consumer_secret);
        }
        res.json(row || null);
    });
});

// Zapis SAMEGO trybu cenowego, niezależnie od reszty konfiguracji sklepu -
// żeby reguła cenowa działała też dla kont bez podłączonego WooCommerce
// (np. produkty dodane ręcznie z ręcznie wpisaną ceną konkurencji).
app.put('/api/tryb-cenowy', wymagajSesji, async (req, res) => {
    const { trybCenowy, wartoscReguly } = req.body;
    const userId = req.session.userId;
    const trybCenowyWartosc = (trybCenowy === 'PROCENT_PONIZEJ_KONKURENCJI' || trybCenowy === 'DOPASUJ_KONKURENCJE') ? trybCenowy : 'AI';
    const wartoscRegulyWartosc = (typeof wartoscReguly === 'number' && wartoscReguly > 0) ? wartoscReguly : 5;
    try {
        await dbRunAsync(
            `INSERT INTO konfiguracja (user_id, tryb_cenowy, wartosc_reguly, zapisano) VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET tryb_cenowy = excluded.tryb_cenowy, wartosc_reguly = excluded.wartosc_reguly`,
            [userId, trybCenowyWartosc, wartoscRegulyWartosc, new Date().toISOString()]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Błąd zapisu trybu cenowego.' });
    }
});

// Globalny domyślny procent Floor Price - stosowany do WSZYSTKICH produktów,
// które nie mają ustawionego własnego, indywidualnego procentu (patrz
// endpoint niżej). Wartość musi być w rozsądnym zakresie (1-99%) - poza tym
// zakresem albo w ogóle nie chroni marży, albo jest bez sensu wysoka.
app.put('/api/floor-price-globalny', wymagajSesji, async (req, res) => {
    const { procent } = req.body;
    const userId = req.session.userId;
    const wartosc = parseFloat(procent);
    if (isNaN(wartosc) || wartosc < 1 || wartosc > 99) {
        return res.status(400).json({ success: false, error: 'Procent Floor Price musi być liczbą od 1 do 99.' });
    }
    try {
        await dbRunAsync(
            `INSERT INTO konfiguracja (user_id, floor_price_procent, zapisano) VALUES (?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET floor_price_procent = excluded.floor_price_procent`,
            [userId, wartosc, new Date().toISOString()]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Błąd zapisu globalnego Floor Price.' });
    }
});

// Nadpisanie Floor Price dla KONKRETNEGO produktu - przydatne, gdy jeden
// produkt ma wyraźnie inną marżę niż reszta asortymentu (np. wąskomarżowy
// towar kupiony blisko ceny sprzedaży). `procent: null` czyści nadpisanie i
// wraca do globalnego ustawienia użytkownika.
app.put('/api/produkty/:id/floor-price', wymagajSesji, async (req, res) => {
    const { id } = req.params;
    const { procent } = req.body;
    const userId = req.session.userId;

    let wartosc = null;
    if (procent !== null && procent !== undefined && procent !== '') {
        wartosc = parseFloat(procent);
        if (isNaN(wartosc) || wartosc < 1 || wartosc > 99) {
            return res.status(400).json({ success: false, error: 'Procent Floor Price musi być liczbą od 1 do 99 (albo pusty, żeby użyć globalnego ustawienia).' });
        }
    }
    try {
        const wynik = await dbRunAsync(`UPDATE globalne_produkty SET floor_price_procent = ? WHERE id = ? AND user_id = ?`, [wartosc, id, userId]);
        if (wynik.changes === 0) return res.status(404).json({ success: false, error: 'Produkt nie istnieje.' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Błąd zapisu Floor Price dla produktu.' });
    }
});

// "Szybka synchronizacja" (zakładka Synchronizacja -> "Uruchom Sync") - używa
// JUŻ ZAPISANEJ konfiguracji sklepu (nie wymaga ponownego wpisywania kluczy).
app.post('/api/synchronizuj', wymagajSesji, async (req, res) => {
    const userId = req.session.userId;
    try {
        const konfiguracja = await dbGetAsync(`SELECT * FROM konfiguracja WHERE user_id = ?`, [userId]);
        if (konfiguracja) {
            konfiguracja.consumer_key = odszyfrujSekret(konfiguracja.consumer_key);
            konfiguracja.consumer_secret = odszyfrujSekret(konfiguracja.consumer_secret);
        }
        const platforma = konfiguracja?.platforma || 'woocommerce';
        if (platforma === 'csv') {
            return res.status(400).json({ success: false, error: 'Tryb "Inny system (CSV)" nie ma automatycznej synchronizacji - użyj importu/eksportu CSV.' });
        }
        const brakDanych = !konfiguracja || !konfiguracja.store_url || !konfiguracja.consumer_secret || (platforma === 'woocommerce' && !konfiguracja.consumer_key);
        if (brakDanych) {
            return res.status(400).json({ success: false, error: 'Brak zapisanej konfiguracji sklepu. Najpierw połącz sklep w sekcji "Konfiguracja integracji".' });
        }
        const wynik = await wykonajImportZPlatformy(
            userId, platforma, konfiguracja.store_url, konfiguracja.consumer_key, konfiguracja.consumer_secret,
            konfiguracja.waluta, konfiguracja.global_auto_pricing !== 0
        );
        res.json({
            success: true,
            message: `Zsynchronizowano ze sklepem: ${wynik.zaimportowano} nowych produktów, ${wynik.zaktualizowanoCene} cen zaktualizowanych, magazyn odświeżony dla ${wynik.magazyn_zsynchronizowany} pozycji, ${wynik.zamowienia_zaimportowano} nowych zamówień (${wynik.zamowienia_zaktualizowano} zaktualizowanych).`,
            ...wynik
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// "Optymalizacja bazy danych" (zakładka Synchronizacja) - prawdziwe VACUUM
// SQLite, porządkuje plik bazy i odzyskuje miejsce po usuniętych wierszach.
app.post('/api/baza/optymalizuj', wymagajSesji, (req, res) => {
    db.run('VACUUM', (err) => {
        if (err) return res.status(500).json({ success: false, error: 'Błąd optymalizacji bazy: ' + err.message });
        res.json({ success: true });
    });
});

// "Awaryjny Przełącznik Cen" (Reset do Bazowych) - pobiera AKTUALNĄ cenę
// bezpośrednio ze sklepu WooCommerce dla każdego połączonego produktu i
// nadpisuje nią lokalną cenę, czyszcząc jednocześnie sugestię AI. Wymaga
// zapisanej, działającej konfiguracji integracji.
app.post('/api/ceny/reset-bazowe', wymagajSesji, async (req, res) => {
    const userId = req.session.userId;
    try {
        // UWAGA: to NIE pobiera już ceny ze sklepu (dawny sposób był błędny -
        // akceptacja sugestii AI nadpisuje TĘ SAMĄ cenę w WooCommerce, więc
        // pobieranie stamtąd "ceny bazowej" w kółko zwracało już zmienioną
        // wartość). Teraz przywracamy z WŁASNEGO, nienadpisywanego pola
        // cena_bazowa - prawdziwej ceny sprzed jakiejkolwiek automatyzacji.
        const produkty = await dbAllAsync(
            `SELECT * FROM globalne_produkty WHERE user_id = ? AND cena_bazowa IS NOT NULL AND cena_bazowa != twoja_cena`,
            [userId]
        );
        if (produkty.length === 0) {
            return res.status(400).json({ success: false, error: 'Wszystkie produkty już mają cenę bazową - nie ma nic do zresetowania.' });
        }

        const terazTekst = new Date().toLocaleString('pl-PL');
        let zresetowano = 0;
        let wyslanoDoSklepu = 0;

        for (const p of produkty) {
            await dbRunAsync(`UPDATE globalne_produkty SET twoja_cena = ?, sugerowana_cena = NULL, rekomendacja = NULL WHERE id = ?`, [p.cena_bazowa, p.id]);
            await dbRunAsync(
                `INSERT INTO historia_zmian_cen (user_id, produkt_id, stara_cena, nowa_cena, zrodlo, data) VALUES (?, ?, ?, ?, ?, ?)`,
                [userId, p.id, p.twoja_cena, p.cena_bazowa, 'Awaryjny reset do ceny bazowej', terazTekst]
            );
            const wynikWyslania = await wyslijCeneJesliPolaczony(userId, p, p.cena_bazowa);
            if (wynikWyslania.wyslano) wyslanoDoSklepu++;
            zresetowano++;
        }
        res.json({ success: true, zresetowano, wyslanoDoSklepu });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============== PRODUKTY ==============
// Uniwersalny import CSV - dla klientów bez WooCommerce/Shopify (dowolny inny
// system), albo po prostu wolących wgrać plik zamiast podpinać API. Front-end
// parsuje CSV po swojej stronie i wysyła gotową tablicę obiektów - prościej i
// bezpieczniej niż parsowanie nieznanego formatu pliku po stronie serwera.
// Oczekiwane kolumny (nagłówki, wielkość liter bez znaczenia): nazwa, ean,
// twoja_cena, cena_konkurencji (opcjonalnie), url_konkurencja (opcjonalnie).
app.post('/api/produkty/import-csv', wymagajSesji, async (req, res) => {
    const userId = req.session.userId;
    const wiersze = Array.isArray(req.body.produkty) ? req.body.produkty : [];
    if (wiersze.length === 0) return res.status(400).json({ success: false, error: 'Plik CSV nie zawiera żadnych poprawnych wierszy.' });

    try {
        const limity = await dbGetAsync(`SELECT limit_produktow FROM limity_uzytkownika WHERE user_id = ?`, [userId]);
        const limitProduktow = limity ? limity.limit_produktow : DOMYSLNY_LIMIT_PRODUKTOW;

        // Deduplikacja PO EAN (jeśli podany) - inaczej powtórne wgranie tego
        // samego pliku (np. zaktualizowanego cennika) tworzyłoby za każdym
        // razem nowe, zdublowane produkty zamiast aktualizować istniejące -
        // dokładnie ten sam mechanizm co przy imporcie z WooCommerce/Shopify.
        const istniejace = await dbAllAsync(`SELECT id, ean, twoja_cena FROM globalne_produkty WHERE user_id = ?`, [userId]);
        const istniejaceMapa = new Map((istniejace || []).filter(p => p.ean).map(p => [p.ean, p]));
        const liczbaObecnych = (istniejace || []).length;

        const konfiguracja = await dbGetAsync(`SELECT global_auto_pricing FROM konfiguracja WHERE user_id = ?`, [userId]);
        const autoPricing = (konfiguracja && konfiguracja.global_auto_pricing === 0) ? 0 : 1;
        const dzis = new Date().toLocaleDateString('pl-PL');
        const terazTekst = new Date().toLocaleString('pl-PL');

        let zaimportowano = 0;
        let zaktualizowano = 0;
        let pominieto = 0;
        let miejsceDostepne = Math.max(0, limitProduktow - liczbaObecnych);

        for (const w of wiersze) {
            const nazwa = String(w.nazwa || '').trim();
            const twojaCena = parseFloat(w.twoja_cena);
            if (!nazwa || isNaN(twojaCena) || twojaCena <= 0) { pominieto++; continue; }
            const ean = String(w.ean || '').trim();
            const cenaStr = twojaCena.toFixed(2);
            const cenaKonkurencjiStr = w.cena_konkurencji ? String(parseFloat(w.cena_konkurencji).toFixed(2)) : '';
            const urlKonkurencji = String(w.url_konkurencja || '').trim();

            const istniejacy = ean ? istniejaceMapa.get(ean) : null;
            if (istniejacy) {
                await dbRunAsync(
                    `UPDATE globalne_produkty SET nazwa = ?, twoja_cena = ?, cena_konkurencji = ?, url_konkurencja = ? WHERE id = ?`,
                    [nazwa, cenaStr, cenaKonkurencjiStr, urlKonkurencji, istniejacy.id]
                );
                if (cenaStr !== parseFloat(istniejacy.twoja_cena).toFixed(2)) {
                    await dbRunAsync(
                        `INSERT INTO historia_zmian_cen (user_id, produkt_id, stara_cena, nowa_cena, zrodlo, data) VALUES (?, ?, ?, ?, ?, ?)`,
                        [userId, istniejacy.id, istniejacy.twoja_cena, cenaStr, 'Import CSV', terazTekst]
                    );
                }
                zaktualizowano++;
                continue;
            }

            if (miejsceDostepne <= 0) { pominieto++; continue; }
            await dbRunAsync(
                `INSERT INTO globalne_produkty (user_id, nazwa, ean, waluta, twoja_cena, cena_bazowa, url_konkurencja, cena_konkurencji, sugerowana_cena, rekomendacja, data, auto_pricing)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
                [userId, nazwa, ean, 'PLN', cenaStr, cenaStr, urlKonkurencji, cenaKonkurencjiStr, dzis, autoPricing]
            );
            zaimportowano++;
            miejsceDostepne--;
        }

        res.json({ success: true, zaimportowano, zaktualizowano, pominieto });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/produkty', wymagajSesji, (req, res) => {
    const { nazwa, ean, waluta, twoja_cena, cena_konkurencji, url_konkurencja, kraj } = req.body;
    if (!nazwa || !twoja_cena) return res.status(400).json({ success: false, error: 'Podaj przynajmniej nazwę produktu i Twoją cenę.' });

    const userId = req.session.userId;
    db.get(`SELECT COUNT(*) AS liczba FROM globalne_produkty WHERE user_id = ?`, [userId], (errCount, wynik) => {
        db.get(`SELECT limit_produktow FROM limity_uzytkownika WHERE user_id = ?`, [userId], (errLimit, limity) => {
            const limitProduktow = limity ? limity.limit_produktow : DOMYSLNY_LIMIT_PRODUKTOW;
            if (wynik && wynik.liczba >= limitProduktow) {
                return res.status(403).json({
                    success: false,
                    error: `Osiągnięto limit ${limitProduktow} produktów w Twoim planie. Przejdź na plan Pro, aby zarządzać całym sklepem.`,
                    limit_osiagniety: true
                });
            }

            // Nowy produkt dziedziczy domyślny stan Auto-pricingu z ostatnio
            // zapisanego globalnego przełącznika w konfiguracji (jeśli istnieje).
            db.get(`SELECT global_auto_pricing FROM konfiguracja WHERE user_id = ?`, [userId], (errKonf, konf) => {
                const autoPricing = (konf && konf.global_auto_pricing === 0) ? 0 : 1;

                db.run(
                    `INSERT INTO globalne_produkty (user_id, nazwa, ean, waluta, twoja_cena, cena_bazowa, url_konkurencja, cena_konkurencji, sugerowana_cena, rekomendacja, data, kraj, auto_pricing)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
                    [userId, nazwa, ean || '', waluta || 'PLN', twoja_cena, twoja_cena, url_konkurencja || '', cena_konkurencji || '', new Date().toLocaleDateString('pl-PL'), kraj || '', autoPricing],
                    function (err) {
                        if (err) return res.status(500).json({ success: false, error: 'Błąd zapisu produktu.' });
                        res.json({ success: true, id: this.lastID });
                    }
                );
            });
        });
    });
});

app.delete('/api/produkty/:id', wymagajSesji, (req, res) => {
    db.run(`DELETE FROM globalne_produkty WHERE id = ? AND user_id = ?`, [req.params.id, req.session.userId], (err) => {
        if (err) return res.status(500).json({ success: false, error: 'Błąd usuwania produktu.' });
        res.json({ success: true });
    });
});

// Przełącznik Auto-pricing PRZY POJEDYNCZYM produkcie (wiersz tabeli).
app.put('/api/produkty/:id/auto', wymagajSesji, (req, res) => {
    const { wlacz } = req.body;
    db.run(`UPDATE globalne_produkty SET auto_pricing = ? WHERE id = ? AND user_id = ?`, [wlacz ? 1 : 0, req.params.id, req.session.userId], (err) => {
        if (err) return res.status(500).json({ success: false, error: 'Błąd zapisu.' });
        res.json({ success: true });
    });
});

// Zbiorcze włączenie/wyłączenie Auto-pricingu dla zaznaczonych produktów (pasek akcji masowych).
app.post('/api/produkty/auto-wsadowo', wymagajSesji, (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    const wlacz = !!req.body.wlacz;
    if (ids.length === 0) return res.status(400).json({ success: false, error: 'Nie wybrano żadnych produktów.' });
    const placeholders = ids.map(() => '?').join(',');
    db.run(
        `UPDATE globalne_produkty SET auto_pricing = ? WHERE id IN (${placeholders}) AND user_id = ?`,
        [wlacz ? 1 : 0, ...ids, req.session.userId],
        (err) => {
            if (err) return res.status(500).json({ success: false, error: 'Błąd zapisu.' });
            res.json({ success: true, zaktualizowano: ids.length });
        }
    );
});

// ============== AUTOMATYCZNE POBIERANIE CENY KONKURENCJI ==============
// Odczytuje cenę ze strony konkurencji na podstawie danych strukturalnych
// (schema.org JSON-LD i meta tagi Open Graph), które większość sklepów
// (w tym WooCommerce) i tak publikuje na stronie produktu z myślą o Google
// i porównywarkach cen - to ten sam, standardowy mechanizm.
function wyciagnijCeneZJsonLd(obiekt) {
    if (!obiekt || typeof obiekt !== 'object') return null;
    if (obiekt.offers) {
        const oferta = Array.isArray(obiekt.offers) ? obiekt.offers[0] : obiekt.offers;
        if (oferta && oferta.price) {
            const cena = parseFloat(String(oferta.price).replace(',', '.'));
            if (!isNaN(cena)) return cena;
        }
    }
    if (obiekt.price) {
        const cena = parseFloat(String(obiekt.price).replace(',', '.'));
        if (!isNaN(cena)) return cena;
    }
    return null;
}

// ============== OCHRONA SSRF ==============
// Adresy stron do sprawdzenia ceny pochodzą z dwóch źródeł: wyników
// wyszukiwania (względnie bezpieczne, bo dobiera je Google/Serper) ORAZ
// linku wklejonego RĘCZNIE przez użytkownika ("Dodaj link"). To drugie źródło
// jest niezaufane - ktoś mógłby wkleić adres wewnętrzny (localhost, sieć
// lokalna, metadata serwera w chmurze) i zmusić serwer, żeby sam się o to
// zapytał. Blokujemy to raz, centralnie, przed KAŻDYM zapytaniem HTTP do
// adresu konkurencji - niezależnie skąd ten adres pochodzi.
const ZABLOKOWANE_WZORCE_HOSTA = [
    /^localhost$/i, /^127\./, /^0\.0\.0\.0$/, /^\[?::1\]?$/, /^\[?::\]?$/,
    /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
    /^169\.254\./, // link-local, w tym metadata endpointy chmurowe (169.254.169.254)
    /^0x/i, /^0[0-7]+$/ // alternatywne zapisy IP (heksadecymalny/oktalny) używane do obchodzenia prostych filtrów
];

function czyUrlBezpieczny(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch (e) {
        return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (ZABLOKOWANE_WZORCE_HOSTA.some(wzorzec => wzorzec.test(host))) return false;
    return true;
}

// Limit rozmiaru pobieranej strony - jeśli serwer (celowo lub przez awarię)
// zwróci gigantyczną odpowiedź, nie chcemy trzymać jej całej w pamięci.
const MAX_ROZMIAR_STRONY_BAJTY = 5 * 1024 * 1024; // 5 MB

async function pobierzTekstZLimitem(res) {
    const dlugoscZNaglowka = parseInt(res.headers.get('content-length') || '0', 10);
    if (dlugoscZNaglowka > MAX_ROZMIAR_STRONY_BAJTY) {
        throw new Error('Strona jest zbyt duża, żeby ją bezpiecznie przetworzyć.');
    }
    if (!res.body || typeof res.body.getReader !== 'function') {
        // Środowisko bez strumieniowania (rzadkie) - wracamy do zwykłego odczytu.
        return await res.text();
    }
    const reader = res.body.getReader();
    const dekoder = new TextDecoder('utf-8');
    let wynik = '';
    let odebranoBajtow = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        odebranoBajtow += value.length;
        if (odebranoBajtow > MAX_ROZMIAR_STRONY_BAJTY) {
            reader.cancel().catch(() => {});
            throw new Error('Strona jest zbyt duża, żeby ją bezpiecznie przetworzyć.');
        }
        wynik += dekoder.decode(value, { stream: true });
    }
    wynik += dekoder.decode();
    return wynik;
}

// `targetCountry`/`targetCurrency` są OPCJONALNE - jeśli podane, funkcja
// spróbuje Kroku B (awaryjny parser AI) na stronie, gdy żadna strategia
// regex nic nie znajdzie. Bez tych parametrów zachowuje się jak wcześniej
// (tylko Krok A). To jedna, wspólna funkcja używana zarówno przy ręcznym
// przycisku "Pobierz cenę", jak i przy codziennym odświeżaniu w harmonogramie
// - Krok B jest teraz dostępny w OBU tych miejscach, nie tylko przy
// automatycznym wyszukiwaniu nowej oferty.
async function pobierzCeneZeStrony(url, targetCountry, targetCurrency) {
    if (!czyUrlBezpieczny(url)) {
        throw new Error('Ten adres URL jest niedozwolony (adres wewnętrzny/lokalny albo nieobsługiwany protokół).');
    }

    let ostatniTekst = null;
    let bladPolaczenia = null;

    // Metoda 1 (szybka): zwykłe zapytanie HTTP + odczyt danych strukturalnych.
    // Nie działa na stronach, które generują cenę dopiero przez JavaScript
    // (np. sklepy jednostronicowe / React), i bywa odrzucana przez proste
    // filtry antybotowe niektórych stron.
    try {
        const wynik = await pobierzCeneSzybko(url);
        if (wynik.cena !== null) return wynik.cena;
        ostatniTekst = wynik.tekst;
    } catch (e) {
        bladPolaczenia = e; // prawdziwy błąd połączenia - próbujemy dalej metodą 2, zanim się poddamy
    }

    // Metoda 2 (zapasowa, wolniejsza): prawdziwa przeglądarka w tle
    // (Puppeteer) - otwiera stronę i czeka aż się w pełni wyrenderuje,
    // dokładnie tak jak zrobiłaby to zwykła osoba klikająca w link.
    // To NIE jest próba oszukania zabezpieczeń - jeśli strona ma
    // świadomą, zaawansowaną ochronę antybotową, ta metoda też zostanie
    // zablokowana, i to jest oczekiwane.
    try {
        const wynik = await pobierzCenePrzezPrzegladarke(url);
        if (wynik.cena !== null) return wynik.cena;
        ostatniTekst = wynik.html || ostatniTekst;
    } catch (bladPrzegladarki) {
        if (!ostatniTekst) {
            throw new Error(`${bladPolaczenia?.message || 'Nie udało się otworzyć strony.'} (dodatkowo próba przez przeglądarkę: ${bladPrzegladarki.message})`);
        }
        // Mamy już HTML z metody 1 (samo wyszukanie ceny w nim zawiodło) -
        // przechodzimy do Kroku B na tym, co już mamy, mimo że Puppeteer się nie powiódł.
    }

    // KROK B: obie metody regexowe (Krok A) odpowiedziały, ale żadna nie
    // znalazła ceny w rozpoznawalnym formacie - jeśli mamy kontekst waluty,
    // pytamy AI awaryjnie wprost o treść strony, zanim ostatecznie się poddamy.
    if (ostatniTekst && targetCurrency) {
        try {
            const wynikAI = await parsujCeneZHtmlAI(ostatniTekst, targetCountry || 'pl', targetCurrency);
            if (wynikAI.found && typeof wynikAI.price === 'number' && wynikAI.price > 0) {
                return wynikAI.price;
            }
        } catch (e) { /* Krok B jest ostatecznością - błąd tutaj nie zmienia komunikatu końcowego */ }
    }

    throw new Error('Nie udało się automatycznie odczytać ceny z tej strony.');
}

// Zwraca { cena, tekst } zamiast rzucać błąd, gdy sama cena nie zostanie
// znaleziona - `tekst` (surowy HTML/JSON strony) jest potrzebny wywołującemu
// do ewentualnego Kroku B (awaryjny parser AI). Nadal RZUCA błąd przy
// prawdziwych problemach z połączeniem (strona nie odpowiada, zła sieć) -
// to co innego niż "strona odpowiedziała, ale nie znaleźliśmy w niej ceny".
async function pobierzCeneSzybko(url) {
    let res;
    const kontroler = new AbortController();
    const przekroczonyCzas = setTimeout(() => kontroler.abort(), 10000); // 10s - jedna wolna strona nie może blokować całej operacji
    try {
        res = await fetch(url, {
            signal: kontroler.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/json,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8'
            }
        });
    } catch (e) {
        throw new Error(e.name === 'AbortError' ? 'Strona nie odpowiedziała na czas (limit 10s).' : 'Nie udało się otworzyć podanego linku. Sprawdź czy adres jest poprawny.');
    } finally {
        clearTimeout(przekroczonyCzas);
    }
    if (!res.ok) throw new Error(`Strona konkurencji zwróciła błąd (status ${res.status}).`);

    const tekst = await pobierzTekstZLimitem(res);

    // Jeśli podany link to adres wewnętrznego API sklepu (zwraca czysty JSON,
    // np. znaleziony ręcznie przez zakładkę Network w przeglądarce), szukaj
    // ceny bezpośrednio w strukturze JSON - to najbardziej wiarygodne źródło,
    // sklepy budują je same na potrzeby własnej strony.
    const wygladaJakJson = tekst.trim().startsWith('{') || tekst.trim().startsWith('[');
    if (wygladaJakJson) {
        try {
            const dane = JSON.parse(tekst);
            const cena = wyciagnijCeneZDowolnegoJson(dane);
            if (cena !== null) return { cena, tekst };
        } catch (e) { /* niepoprawny JSON - spróbuj dalej jako HTML */ }
    }

    const domena = domenaZUrl(url);
    const preferowanaStrategia = domena ? await pobierzZnanaStrategieDomeny(domena) : null;
    const { cena, strategia } = wyciagnijCeneZHtmlZeStrategia(tekst, preferowanaStrategia);
    if (cena !== null) {
        if (domena) zapiszStrategieDomeny(domena, strategia);
        return { cena, tekst };
    }
    return { cena: null, tekst }; // strona odpowiedziała, ale żadna strategia regex nic nie znalazła - zwracamy HTML do Kroku B
}

// Przeszukuje DOWOLNĄ strukturę JSON (nie tylko schema.org) w poszukiwaniu
// pola, które wygląda jak cena - przydatne przy wewnętrznych API sklepów,
// które nie trzymają się jednego standardu nazewnictwa pól.
function wyciagnijCeneZDowolnegoJson(dane, glebokosc = 0) {
    if (glebokosc > 5 || dane === null || typeof dane !== 'object') return null;

    const mozliwePola = ['price', 'regular_price', 'salePrice', 'sale_price', 'amount', 'cena', 'finalPrice', 'final_price', 'currentPrice', 'value'];
    for (const pole of mozliwePola) {
        if (dane[pole] !== undefined && dane[pole] !== null) {
            const cena = parseFloat(String(dane[pole]).replace(',', '.'));
            if (!isNaN(cena) && cena > 0) return cena;
        }
    }

    for (const klucz of Object.keys(dane)) {
        const wynik = wyciagnijCeneZDowolnegoJson(dane[klucz], glebokosc + 1);
        if (wynik !== null) return wynik;
    }
    return null;
}

// Wyciąga cenę z surowego HTML (używane zarówno przez szybką metodę, jak i
// przez wynik z prawdziwej przeglądarki poniżej).
// Wyciąga cenę OSOBNO z każdej strategii (dane strukturalne JSON-LD, meta
// tagi, widoczne elementy ceny na stronie) - zamiast zwracać tylko pierwsze
// dopasowanie. To pozwala PORÓWNAĆ, czy różne źródła na tej samej stronie
// zgadzają się ze sobą. Ochrona przed manipulacją: nieuczciwy sprzedawca
// mógłby wpisać zaniżoną cenę WYŁĄCZNIE w niewidocznych danych JSON-LD
// (żeby zmylić automaty typu porównywarki cen), podczas gdy realna cena na
// stronie (widoczna dla klienta) jest inna. Rozbieżność między źródłami jest
// sygnałem ostrzegawczym, nawet jeśli każde z osobna wygląda poprawnie.
function wyciagnijWszystkieKandydatoweCeny(html) {
    const wynik = { jsonld: null, mikrodane: null, meta: null, dataAtrybut: null, element: null };

    const jsonLdBloki = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    for (const dopasowanie of jsonLdBloki) {
        try {
            const dane = JSON.parse(dopasowanie[1].trim());
            const kandydaci = Array.isArray(dane) ? dane : (Array.isArray(dane['@graph']) ? dane['@graph'] : [dane]);
            for (const obiekt of kandydaci) {
                const cena = wyciagnijCeneZJsonLd(obiekt);
                if (cena) { wynik.jsonld = cena; break; }
            }
        } catch (e) { /* niepoprawny JSON-LD - pomiń */ }
        if (wynik.jsonld) break;
    }

    // Mikrodane schema.org (itemprop="price") - starszy, ale wciąż bardzo
    // popularny standard (m.in. wiele motywów WooCommerce/Shopify) obok
    // JSON-LD. Cena bywa w atrybucie content= (niewidoczna) albo wprost w
    // tekście elementu (widoczna).
    const wzorceMikrodanych = [
        /<[^>]+itemprop=["']price["'][^>]*content=["']([\d.,]+)["']/i,
        /<[^>]+itemprop=["']price["'][^>]*>\s*([\d][\d.,\s]*\d|\d)/i
    ];
    for (const wzorzec of wzorceMikrodanych) {
        const dopasowanie = html.match(wzorzec);
        if (dopasowanie) {
            const cena = parseFloat(dopasowanie[1].replace(/\s/g, '').replace(',', '.'));
            if (!isNaN(cena) && cena > 0) { wynik.mikrodane = cena; break; }
        }
    }

    const wzorceMeta = [
        /<meta[^>]+(?:property|name)=["'](?:product:price:amount|og:price:amount)["'][^>]+content=["']([\d.,]+)["']/i,
        /<meta[^>]+content=["']([\d.,]+)["'][^>]+(?:property|name)=["'](?:product:price:amount|og:price:amount)["']/i
    ];
    for (const wzorzec of wzorceMeta) {
        const dopasowanie = html.match(wzorzec);
        if (dopasowanie) {
            const cena = parseFloat(dopasowanie[1].replace(',', '.'));
            if (!isNaN(cena)) { wynik.meta = cena; break; }
        }
    }

    // Atrybut data-price - powszechny w sklepach renderowanych/sterowanych
    // przez JavaScript (cena wstrzykiwana do atrybutu danych elementu, np.
    // przycisku "Dodaj do koszyka"), gdzie JSON-LD bywa pomijany.
    const dopasowanieDataPrice = html.match(/data-(?:price|product-price)=["']([\d.,]+)["']/i);
    if (dopasowanieDataPrice) {
        const cena = parseFloat(dopasowanieDataPrice[1].replace(',', '.'));
        if (!isNaN(cena) && cena > 0) wynik.dataAtrybut = cena;
    }

    // Strategia ostatnia, najmniej pewna: szukaj elementów HTML, których
    // klasa/id sugeruje że to cena (np. class="price", "product-price").
    // Mniej wiarygodne niż dane strukturalne - może czasem złapać złą liczbę
    // (np. koszt dostawy albo cenę innego produktu na stronie), dlatego
    // sprawdzane jest jako ostatnie, dopiero gdy dokładniejsze metody zawiodą.
    const wzorzecElementowCeny = /<[^>]+(?:class|id)=["'][^"']*price[^"']*["'][^>]*>([\s\S]{0,120}?)<\/[a-z]+>/gi;
    let dopasowanieCeny;
    while ((dopasowanieCeny = wzorzecElementowCeny.exec(html)) !== null) {
        const fragment = dopasowanieCeny[1].replace(/<[^>]+>/g, ' ');
        const liczba = fragment.match(/(\d{1,3}(?:[ .]?\d{3})*(?:[.,]\d{2})?)\s*(zł|PLN|€|EUR|\$|USD|£|GBP)?/i);
        if (liczba) {
            const wartosc = parseFloat(liczba[1].replace(/\s/g, '').replace(',', '.'));
            if (!isNaN(wartosc) && wartosc > 0) { wynik.element = wartosc; break; }
        }
    }

    return wynik;
}

// Sprawdza, czy dane strukturalne (JSON-LD/meta - "niewidoczne" dla klienta)
// rażąco różnią się od ceny widocznej w treści strony. Rozbieżność powyżej
// 20% to sygnał, że coś jest nie tak - może to być zwykła niespójność danych
// sklepu, ale może to też być próba wprowadzenia w błąd automatów. W obu
// przypadkach lepiej to zasygnalizować niż zaufać w ciemno.
function wykryjRozbieznoscCeny(html) {
    const kandydaci = wyciagnijWszystkieKandydatoweCeny(html);
    // "Ukryta" = pierwsza dostępna cena z danych strukturalnych (niewidoczna
    // wprost dla klienta), "widoczna" = to, co faktycznie widać na stronie.
    const ukryta = kandydaci.jsonld ?? kandydaci.mikrodane ?? kandydaci.meta ?? kandydaci.dataAtrybut;
    const widoczna = kandydaci.element;
    if (ukryta === null || ukryta === undefined || widoczna === null || ukryta <= 0 || widoczna <= 0) {
        return { rozbieznosc: false, ukryta, widoczna };
    }
    const stosunek = Math.max(ukryta, widoczna) / Math.min(ukryta, widoczna);
    return { rozbieznosc: stosunek >= 1.2, ukryta, widoczna };
}

// Sprawdza, czy oferta konkurencji jest w ogóle DOSTĘPNA - bez tego system
// mógłby polecić dopasowanie do ceny produktu, którego konkurent już nie ma
// na stanie (cena wygląda atrakcyjnie, ale nie odzwierciedla realnego rynku).
// Priorytet: pole `availability` ze schema.org (najbardziej wiarygodne, bo
// to ustandaryzowane dane), a jeśli go brak - proste dopasowanie tekstowe
// najczęstszych fraz "brak w magazynie" po polsku i angielsku jako fallback.
function wyciagnijDostepnosc(html) {
    const bloki = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    for (const blok of bloki) {
        try {
            const dane = JSON.parse(blok[1].trim());
            const kandydaci = Array.isArray(dane) ? dane : (Array.isArray(dane['@graph']) ? dane['@graph'] : [dane]);
            for (const obiekt of kandydaci) {
                const oferta = Array.isArray(obiekt.offers) ? obiekt.offers[0] : obiekt.offers;
                if (oferta && oferta.availability) {
                    const wartosc = String(oferta.availability).toLowerCase();
                    if (wartosc.includes('outofstock') || wartosc.includes('soldout') || wartosc.includes('discontinued')) return 'niedostepny';
                    if (wartosc.includes('instock') || wartosc.includes('limitedavailability') || wartosc.includes('preorder') || wartosc.includes('backorder')) return 'dostepny';
                }
            }
        } catch (e) { /* niepoprawny JSON-LD - pomiń */ }
    }

    // Fallback: bez ustandaryzowanych danych, szukamy najczęstszych fraz
    // wprost w treści strony. Mniej pewne niż schema.org, dlatego tylko
    // jako druga linia - fałszywy alarm jest tu bardziej prawdopodobny.
    const tekst = html.toLowerCase();
    if (/brak w magazynie|niedostępny produkt|produkt niedostępny|obecnie niedostępny|out of stock|currently unavailable|sold out/.test(tekst)) {
        return 'niedostepny';
    }
    return 'nieznana';
}

// Domenowa kolejność strategii - domyślna, ustandaryzowana kolejność
// priorytetów, modyfikowana per domena, jeśli mamy już sprawdzoną historię.
const KOLEJNOSC_STRATEGII_DOMYSLNA = ['jsonld', 'mikrodane', 'meta', 'dataAtrybut', 'element'];

function domenaZUrl(url) {
    try { return new URL(url).hostname.replace(/^www\./i, '').toLowerCase(); } catch (e) { return null; }
}

async function pobierzZnanaStrategieDomeny(domena) {
    if (!domena) return null;
    try {
        const wiersz = await dbGetAsync(`SELECT strategia FROM strategia_ekstrakcji_domeny WHERE domena = ?`, [domena]);
        return wiersz ? wiersz.strategia : null;
    } catch (e) {
        return null;
    }
}

// Zapis jest celowo "fire and forget" (bez await w miejscu wywołania) - to
// tylko optymalizacja przyszłych zapytań, nie może spowalniać bieżącej
// odpowiedzi ani jej blokować w razie błędu zapisu.
function zapiszStrategieDomeny(domena, strategia) {
    if (!domena || !strategia) return;
    dbRunAsync(
        `INSERT INTO strategia_ekstrakcji_domeny (domena, strategia, zapisano) VALUES (?, ?, ?)
         ON CONFLICT(domena) DO UPDATE SET strategia = excluded.strategia, zapisano = excluded.zapisano`,
        [domena, strategia, new Date().toISOString()]
    ).catch(() => {});
}

// Zwraca {cena, strategia} zamiast samej liczby, żeby wywołujący mógł
// zapamiętać, KTÓRA strategia zadziałała dla danej domeny. Jeśli podano
// `preferowanaStrategia` (ze znanej historii tej domeny) i ona też daje
// wynik, ufamy jej przed sztywnym priorytetem domyślnym - to sprawdzona,
// specyficzna dla tej konkretnej strony metoda.
function wyciagnijCeneZHtmlZeStrategia(html, preferowanaStrategia) {
    const kandydaci = wyciagnijWszystkieKandydatoweCeny(html);
    const kolejnosc = (preferowanaStrategia && KOLEJNOSC_STRATEGII_DOMYSLNA.includes(preferowanaStrategia))
        ? [preferowanaStrategia, ...KOLEJNOSC_STRATEGII_DOMYSLNA.filter(s => s !== preferowanaStrategia)]
        : KOLEJNOSC_STRATEGII_DOMYSLNA;
    for (const strategia of kolejnosc) {
        if (kandydaci[strategia] !== null) return { cena: kandydaci[strategia], strategia };
    }
    return { cena: null, strategia: null };
}

function wyciagnijCeneZHtml(html) {
    return wyciagnijCeneZHtmlZeStrategia(html, null).cena;
}

// Lekkie, samodzielne pobranie HTML wyłącznie do diagnostyki (rozbieżność
// cen + dostępność) - używane w automatycznym wyszukiwaniu konkurencji. NIE
// rzuca błędu przy niepowodzeniu, tylko zwraca null, bo to sygnał pomocniczy,
// a nie krytyczna ścieżka. Respektuje te same zabezpieczenia (SSRF, limit
// czasu, limit rozmiaru), co główna funkcja pobierania ceny.
async function pobierzHtmlDlaDiagnostyki(url) {
    if (!czyUrlBezpieczny(url)) return null;
    const kontroler = new AbortController();
    const przekroczonyCzas = setTimeout(() => kontroler.abort(), 8000);
    try {
        const res = await fetch(url, {
            signal: kontroler.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' }
        });
        if (!res.ok) return null;
        return await pobierzTekstZLimitem(res);
    } catch (e) {
        return null;
    } finally {
        clearTimeout(przekroczonyCzas);
    }
}

let puppeteerModul = null;
function pobierzPuppeteer() {
    if (puppeteerModul === null) {
        try {
            puppeteerModul = require('puppeteer');
        } catch (e) {
            puppeteerModul = false;
        }
    }
    return puppeteerModul;
}

// Analogicznie do pobierzCeneSzybko - zwraca { cena, html } zamiast rzucać
// błąd, gdy sama cena nie zostanie znaleziona, żeby wywołujący mógł spróbować
// Kroku B (AI) na już wyrenderowanym HTML zamiast po prostu się poddawać.
async function pobierzCenePrzezPrzegladarke(url) {
    const puppeteer = pobierzPuppeteer();
    if (!puppeteer) {
        throw new Error('Biblioteka Puppeteer nie jest zainstalowana (npm install puppeteer)');
    }

    let przegladarka;
    try {
        przegladarka = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const strona = await przegladarka.newPage();
        await strona.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');
        await strona.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
        const html = await strona.content();
        const domena = domenaZUrl(url);
        const preferowanaStrategia = domena ? await pobierzZnanaStrategieDomeny(domena) : null;
        const { cena, strategia } = wyciagnijCeneZHtmlZeStrategia(html, preferowanaStrategia);
        if (cena !== null) {
            if (domena) zapiszStrategieDomeny(domena, strategia);
            return { cena, html };
        }
        return { cena: null, html };
    } catch (e) {
        throw new Error(e.message || 'Błąd podczas otwierania strony w przeglądarce.');
    } finally {
        if (przegladarka) await przegladarka.close().catch(() => {});
    }
}

// ============== AUTOMATYCZNE WYSZUKIWANIE KONKURENCJI (globalne) ==============
// Zamiast wymagać ręcznie podanego linku, przeszukuje globalną bazę ofert
// Google Shopping (przez Serper.dev) po nazwie produktu, a następnie AI
// wybiera ofertę, która najlepiej odpowiada temu samemu produktowi.
// Mapuje walutę produktu na kod kraju Google (parametr "gl" w Serper) - żeby
// wyniki wyszukiwania pochodziły z właściwego regionu/waluty, zamiast
// domyślnie amerykańskich wyników w USD.
// UWAGA - uczciwe zastrzeżenie: EUR domyślnie mapuje na Niemcy, bo sama
// waluta nie mówi z jakiego kraju strefy euro jest sprzedawca (Francuz,
// Hiszpan i Niemiec wszyscy używają EUR). To pragmatyczne uproszczenie
// (ceny w euro są zwykle zbliżone w całej strefie) - pełna precyzja
// wymagałaby osobnego pola "kraj" niezależnego od waluty.
function krajDlaWaluty(waluta) {
    return {
        PLN: 'pl', EUR: 'de', USD: 'us', GBP: 'gb', CHF: 'ch',
        JPY: 'jp', CAD: 'ca', AUD: 'au', SEK: 'se', NOK: 'no',
        DKK: 'dk', CZK: 'cz', CNY: 'cn', INR: 'in', BRL: 'br', MXN: 'mx'
    }[waluta] || 'us';
}

// Symbol/kod waluty do sprawdzenia, czy znaleziona oferta faktycznie jest
// w tej samej walucie co produkt - inaczej porównanie cen jest bez sensu
// (np. "429" może być dolarami, nie złotówkami).
function wzorzecWalutyDlaFiltra(waluta) {
    return {
        PLN: /zł|PLN/i, EUR: /€|EUR/i, USD: /\$|USD/i, GBP: /£|GBP/i, CHF: /CHF|Fr\.?/i,
        JPY: /¥|JPY|円/i, CAD: /CAD|C\$/i, AUD: /AUD|A\$/i, SEK: /SEK|kr\b/i, NOK: /NOK|kr\b/i,
        DKK: /DKK|kr\b/i, CZK: /CZK|Kč/i, CNY: /CNY|RMB|元/i, INR: /INR|₹/i, BRL: /BRL|R\$/i, MXN: /MXN|Mex\$/i
    }[waluta] || /\$|USD/i;
}

// Generuje kilka wariantów zapisu tego samego kodu EAN - różne sklepy/
// wyszukiwarki bywają czułe na formatowanie (spacje, myślniki, wiodące
// zero przy zapisie EAN-13 jako UPC-A). Próbujemy kilku sensownych wariantów
// zamiast poddawać się po pierwszym niepowodzeniu.
function wariantyEan(ean) {
    const surowy = String(ean).trim();
    const samecyfry = surowy.replace(/[^0-9]/g, '');
    const warianty = new Set([surowy, samecyfry]);
    if (samecyfry.length === 13 && samecyfry.startsWith('0')) {
        warianty.add(samecyfry.slice(1)); // EAN-13 z wiodącym zerem zapisany jako UPC-A (12 cyfr)
    }
    if (samecyfry.length === 12) {
        warianty.add('0' + samecyfry); // odwrotnie: UPC-A rozszerzony do EAN-13
    }
    return [...warianty].filter(w => w.length >= 8);
}

const TTL_CACHE_WYSZUKIWANIA_MS = 24 * 60 * 60 * 1000; // 24h - te same surowe wyniki są ważne przez dobę

async function pobierzZCache(klucz) {
    try {
        const wiersz = await dbGetAsync(`SELECT oferty_json, zapisano FROM cache_wyszukiwan_konkurencji WHERE klucz = ?`, [klucz]);
        if (!wiersz) return null;
        const wiek = Date.now() - new Date(wiersz.zapisano).getTime();
        if (wiek > TTL_CACHE_WYSZUKIWANIA_MS) return null;
        return JSON.parse(wiersz.oferty_json);
    } catch (e) {
        return null;
    }
}

async function zapiszDoCache(klucz, oferty) {
    try {
        await dbRunAsync(
            `INSERT INTO cache_wyszukiwan_konkurencji (klucz, oferty_json, zapisano) VALUES (?, ?, ?)
             ON CONFLICT(klucz) DO UPDATE SET oferty_json = excluded.oferty_json, zapisano = excluded.zapisano`,
            [klucz, JSON.stringify(oferty), new Date().toISOString()]
        );
    } catch (e) { /* cache jest optymalizacją, nie krytyczną ścieżką - błąd zapisu ignorujemy */ }
}

// ============== ALLEGRO API (Metoda B - oficjalne, dedykowane API) ==============
// W przeciwieństwie do Serper/SerpApi (które same scrapują Google Shopping)
// i Ceneo (publiczna strona wyników), to jest PRAWDZIWE, oficjalne REST API
// platformy handlowej - najwyższa możliwa wiarygodność danych z tego źródła,
// ale wymaga zarejestrowania własnej aplikacji na apps.developer.allegro.pl
// (darmowe), skąd bierze się ALLEGRO_CLIENT_ID i ALLEGRO_CLIENT_SECRET.
// UWAGA: to wdrożenie nie zostało przetestowane na żywym API (brak dostępu
// do internetu w środowisku, w którym to piszę) - dokładny kształt odpowiedzi
// (zwłaszcza konstrukcja linku do oferty) może wymagać drobnej korekty po
// pierwszym realnym teście. Awaria tego dostawcy jest nieszkodliwa - po
// prostu zwraca 0 wyników, reszta dostawców działa dalej.
let tokenAllegro = { wartosc: null, wygasa: 0 };

async function pobierzTokenAllegro() {
    if (tokenAllegro.wartosc && Date.now() < tokenAllegro.wygasa) return tokenAllegro.wartosc;
    if (!process.env.ALLEGRO_CLIENT_ID || !process.env.ALLEGRO_CLIENT_SECRET) return null;

    const authHeader = 'Basic ' + Buffer.from(`${process.env.ALLEGRO_CLIENT_ID}:${process.env.ALLEGRO_CLIENT_SECRET}`).toString('base64');
    try {
        const res = await fetch('https://allegro.pl/auth/oauth/token?grant_type=client_credentials', {
            method: 'POST',
            headers: { Authorization: authHeader }
        });
        if (!res.ok) return null;
        const dane = await res.json();
        if (!dane.access_token) return null;
        // Odejmujemy 60s od realnego czasu wygaśnięcia jako margines bezpieczeństwa.
        tokenAllegro = { wartosc: dane.access_token, wygasa: Date.now() + Math.max(0, (dane.expires_in || 3600) - 60) * 1000 };
        return tokenAllegro.wartosc;
    } catch (e) {
        return null;
    }
}

async function pobierzOfertyZGoogleShopping(nazwaProduktu, waluta, krajOverride, twojaCena, ean) {
    // Jeśli produkt ma jawnie ustawiony kraj, użyj go zamiast zgadywać z
    // samej waluty (to dokładnie rozwiązuje niejednoznaczność strefy euro -
    // Francuz i Niemiec obaj mają EUR, ale to różne kraje wyszukiwania).
    const kodKraju = (krajOverride && krajOverride.trim()) ? krajOverride.trim().toLowerCase() : krajDlaWaluty(waluta);

    // Język wyników wyszukiwania (parametr hl) - osobny od kraju (gl), bo
    // wyszukiwarki traktują je jako dwa niezależne parametry. Bez tego np.
    // wyszukiwanie na rynku PL mogłoby zwracać angielskie opisy ofert.
    const kodJezyka = {
        pl: 'pl', de: 'de', fr: 'fr', es: 'es', it: 'it', nl: 'nl', at: 'de', be: 'nl', pt: 'pt', ie: 'en',
        us: 'en', gb: 'en', ch: 'de', jp: 'ja', ca: 'en', au: 'en', se: 'sv', no: 'no', dk: 'da', cz: 'cs',
        cn: 'zh-cn', in: 'en', br: 'pt-br', mx: 'es'
    }[kodKraju] || 'en';

    // Jeśli dosłownie żadne źródło nie jest dostępne dla tego rynku - jasny
    // komunikat zamiast mylącego "nic nie znaleziono". Lokalni dostawcy
    // (Ceneo/Allegro dla PL, Idealo dla wybranych krajów UE) liczą się jako
    // dostępne źródło nawet bez kluczy Serper/SerpApi.
    const KRAJE_Z_LOKALNYM_DOSTAWCA = ['pl', 'de', 'at', 'fr', 'es', 'it', 'nl', 'gb'];
    if (!process.env.SERPER_API_KEY && !process.env.SERPAPI_API_KEY && !KRAJE_Z_LOKALNYM_DOSTAWCA.includes(kodKraju)) {
        throw new Error('Brak dostępnych źródeł wyszukiwania konkurencji dla tego rynku - ustaw SERPER_API_KEY lub SERPAPI_API_KEY w .env (lokalni dostawcy bez klucza obsługują tylko: PL, DE, AT, FR, ES, IT, NL, GB).');
    }

    // ---- WARSTWA DOSTAWCÓW (wiele niezależnych źródeł danych) ----
    // Jedno źródło danych to pojedynczy punkt awarii: jeśli konkurent nie
    // jest zaindeksowany akurat w Google Shopping (mały sklep, źle
    // skonfigurowany feed produktowy), nic go nie znajdzie, niezależnie jak
    // dobre jest AI. Dlatego odpytujemy WSZYSTKICH dostępnych dostawców i
    // łączymy wyniki - każdy dostawca to zwykłe, publiczne zapytanie HTTP
    // (bez omijania zabezpieczeń, bez proxy), zgodnie z resztą aplikacji.
    async function dostawcaSerper(zapytanie) {
        if (!process.env.SERPER_API_KEY) return []; // brak klucza - ten dostawca po prostu nic nie wnosi, reszta i tak działa
        const res = await fetch('https://google.serper.dev/shopping', {
            method: 'POST',
            headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: zapytanie, gl: kodKraju, hl: kodJezyka })
        });
        if (!res.ok) {
            const tekst = await res.text().catch(() => '');
            throw new Error(`Serper API zwróciło błąd ${res.status}: ${tekst.slice(0, 200)}`);
        }
        const dane = await res.json();
        const wyniki = Array.isArray(dane.shopping) ? dane.shopping : [];
        return wyniki.slice(0, 10).map(w => ({ tytul: w.title, cena: w.price, sklep: w.source, link: w.link }));
    }

    // Drugi, niezależny dostawca - Ceneo.pl, największa polska porównywarka
    // cen. Nie wymaga żadnego klucza API (zwykłe, publiczne zapytanie HTTP,
    // tak samo jak reszta aplikacji czyta dane strukturalne ze stron), ale
    // obsługuje wyłącznie rynek polski. UWAGA: parsowanie oparte jest o dane
    // strukturalne (JSON-LD), które Ceneo MOŻE (nie musi) publikować na
    // stronach wyników - jeśli struktura strony się zmieni, ten dostawca po
    // prostu zwróci 0 wyników (nieszkodliwie, reszta dostawców działa dalej).
    async function dostawcaCeneo(zapytanie) {
        if (kodKraju !== 'pl') return [];
        const url = `https://www.ceneo.pl/;szukaj-${zapytanie.trim().split(/\s+/).map(encodeURIComponent).join('+')}`;
        if (!czyUrlBezpieczny(url)) return [];

        const kontroler = new AbortController();
        const czas = setTimeout(() => kontroler.abort(), 8000);
        let res;
        try {
            res = await fetch(url, {
                signal: kontroler.signal,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' }
            });
        } catch (e) {
            return [];
        } finally {
            clearTimeout(czas);
        }
        if (!res.ok) return [];

        let html;
        try { html = await pobierzTekstZLimitem(res); } catch (e) { return []; }

        const wyniki = [];
        const bloki = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
        for (const blok of bloki) {
            try {
                const dane = JSON.parse(blok[1].trim());
                const kandydaci = Array.isArray(dane) ? dane : (Array.isArray(dane.itemListElement) ? dane.itemListElement : [dane]);
                for (const el of kandydaci) {
                    const produkt = el.item || el;
                    if (!produkt || !produkt.name) continue;
                    const oferta = Array.isArray(produkt.offers) ? produkt.offers[0] : produkt.offers;
                    if (oferta && oferta.price) {
                        wyniki.push({ tytul: produkt.name, cena: String(oferta.price), sklep: 'Ceneo.pl', link: produkt.url || url });
                    }
                }
            } catch (e) { /* pomiń niepoprawny blok JSON-LD */ }
        }
        return wyniki.slice(0, 10);
    }

    // Trzeci, niezależny dostawca - SerpApi (silnik "google_shopping"). Jak
    // Serper, wymaga płatnego klucza API, ale to inny dostawca infrastruktury
    // scrapingowej (inne proxy, inny indeks, inne okna czasowe odświeżania) -
    // realnie zwiększa szansę znalezienia oferty, której akurat brakuje u
    // pierwszego dostawcy, zamiast dublować to samo źródło.
    async function dostawcaSerpApi(zapytanie) {
        if (!process.env.SERPAPI_API_KEY) return []; // brak klucza - ten dostawca po prostu nic nie wnosi, reszta i tak działa
        const parametry = new URLSearchParams({
            engine: 'google_shopping',
            q: zapytanie,
            gl: kodKraju,
            hl: kodJezyka,
            currency: waluta,
            api_key: process.env.SERPAPI_API_KEY
        });
        const kontroler = new AbortController();
        const czas = setTimeout(() => kontroler.abort(), 10000);
        let res;
        try {
            res = await fetch(`https://serpapi.com/search.json?${parametry.toString()}`, { signal: kontroler.signal });
        } catch (e) {
            return [];
        } finally {
            clearTimeout(czas);
        }
        if (!res.ok) {
            const tekst = await res.text().catch(() => '');
            throw new Error(`SerpApi zwróciło błąd ${res.status}: ${tekst.slice(0, 200)}`);
        }
        const dane = await res.json();
        const wyniki = Array.isArray(dane.shopping_results) ? dane.shopping_results : [];
        return wyniki.slice(0, 10).map(w => ({
            tytul: w.title,
            cena: (w.extracted_price !== undefined && w.extracted_price !== null) ? String(w.extracted_price) : w.price,
            sklep: w.source,
            link: w.product_link || w.link
        }));
    }

    // Lista aktywnych dostawców - odpytywani PO KOLEI, wyniki łączone (nie
    // przerywamy po pierwszym trafieniu), żeby zmaksymalizować szansę na
    // znalezienie prawdziwej oferty konkurencji.
    // Czwarty, niezależny dostawca - Allegro API (oficjalne, Metoda B).
    // Obsługuje wyłącznie rynek polski - Allegro to platforma stricte PL/CZ.
    async function dostawcaAllegro(zapytanie) {
        if (kodKraju !== 'pl') return [];
        const token = await pobierzTokenAllegro();
        if (!token) return []; // brak skonfigurowanych kluczy albo błąd autoryzacji - ten dostawca po prostu nic nie wnosi

        const kontroler = new AbortController();
        const czas = setTimeout(() => kontroler.abort(), 8000);
        let res;
        try {
            res = await fetch(`https://api.allegro.pl/offers/listing?phrase=${encodeURIComponent(zapytanie)}&limit=10`, {
                signal: kontroler.signal,
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.allegro.public.v1+json'
                }
            });
        } catch (e) {
            return [];
        } finally {
            clearTimeout(czas);
        }
        if (!res.ok) return [];

        let dane;
        try { dane = await res.json(); } catch (e) { return []; }
        const wyniki = Array.isArray(dane?.items?.promoted) ? dane.items.promoted.concat(dane.items.regular || []) : (dane?.items?.regular || []);

        return wyniki.slice(0, 10).map(oferta => ({
            tytul: oferta.name,
            cena: oferta.sellingMode?.price?.amount,
            sklep: 'Allegro',
            link: oferta.id ? `https://allegro.pl/oferta/${oferta.id}` : null
        })).filter(o => o.tytul && o.cena && o.link);
    }

    // Piąty, niezależny dostawca - Idealo, europejska porównywarka cen
    // działająca lokalnie w kilku krajach (osobna domena per kraj, ale ta
    // sama struktura strony) - JEDEN parser pokrywa od razu kilka rynków,
    // zamiast budować osobną integrację per kraj. Podobnie jak Ceneo, nie
    // wymaga klucza API (zwykłe publiczne zapytanie HTTP).
    // UWAGA: podobnie jak Ceneo, ta integracja NIE została przetestowana na
    // żywej stronie (brak dostępu do internetu w środowisku, w którym to
    // piszę) - zarówno dokładny wzorzec adresu wyszukiwania, jak i to, czy
    // strona faktycznie publikuje dane JSON-LD na liście wyników, może wymagać
    // korekty po pierwszym realnym teście. Bezpieczny fallback: 0 wyników.
    const DOMENY_IDEALO = {
        de: 'idealo.de', at: 'idealo.at', fr: 'idealo.fr', es: 'idealo.es',
        it: 'idealo.it', nl: 'idealo.nl', gb: 'idealo.co.uk'
    };
    async function dostawcaIdealo(zapytanie) {
        const domena = DOMENY_IDEALO[kodKraju];
        if (!domena) return []; // Idealo nie działa w tym kraju - nic nie tracimy, reszta dostawców działa dalej

        const url = `https://www.${domena}/search?q=${encodeURIComponent(zapytanie)}`;
        if (!czyUrlBezpieczny(url)) return [];

        const kontroler = new AbortController();
        const czas = setTimeout(() => kontroler.abort(), 8000);
        let res;
        try {
            res = await fetch(url, {
                signal: kontroler.signal,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' }
            });
        } catch (e) {
            return [];
        } finally {
            clearTimeout(czas);
        }
        if (!res.ok) return [];

        let html;
        try { html = await pobierzTekstZLimitem(res); } catch (e) { return []; }

        const wyniki = [];
        const bloki = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
        for (const blok of bloki) {
            try {
                const dane = JSON.parse(blok[1].trim());
                const kandydaci = Array.isArray(dane) ? dane : (Array.isArray(dane.itemListElement) ? dane.itemListElement : [dane]);
                for (const el of kandydaci) {
                    const produkt = el.item || el;
                    if (!produkt || !produkt.name) continue;
                    const oferta = Array.isArray(produkt.offers) ? produkt.offers[0] : produkt.offers;
                    if (oferta && oferta.price) {
                        wyniki.push({ tytul: produkt.name, cena: String(oferta.price), sklep: `Idealo.${domena.split('.').slice(1).join('.')}`, link: produkt.url || url });
                    }
                }
            } catch (e) { /* pomiń niepoprawny blok JSON-LD */ }
        }
        return wyniki.slice(0, 10);
    }

    // Lista aktywnych dostawców - odpytywani PO KOLEI, wyniki łączone (nie
    // przerywamy po pierwszym trafieniu), żeby zmaksymalizować szansę na
    // znalezienie prawdziwej oferty konkurencji. Serper i SerpApi (Google
    // Shopping) pokrywają WSZYSTKIE kraje - to baza globalna. Ceneo, Allegro
    // i Idealo to dodatkowe, lokalne źródła, które same "wyłączają się" (zwracają
    // pustą listę) poza swoim krajem/krajami - nie trzeba ich warunkować z zewnątrz.
    const DOSTAWCY = [dostawcaSerper, dostawcaSerpApi, dostawcaCeneo, dostawcaAllegro, dostawcaIdealo];

    async function wyszukajUDostawcow(zapytanie) {
        let wszystkieWyniki = [];
        let ostatniBlad = null;
        for (const dostawca of DOSTAWCY) {
            try {
                const wynik = await dostawca(zapytanie);
                wszystkieWyniki = wszystkieWyniki.concat(wynik);
            } catch (e) {
                ostatniBlad = e; // błąd jednego dostawcy nie blokuje pozostałych
            }
        }
        if (wszystkieWyniki.length === 0 && ostatniBlad) throw ostatniBlad;
        return wszystkieWyniki;
    }

    // ---- CACHE (wspólny dla wszystkich użytkowników, klucz = zapytanie+kraj) ----
    async function wyszukajZCache(zapytanie) {
        const klucz = `${zapytanie.toLowerCase()}|${kodKraju}`;
        const zCache = await pobierzZCache(klucz);
        if (zCache) return zCache;
        const swieze = await wyszukajUDostawcow(zapytanie);
        if (swieze.length > 0) await zapiszDoCache(klucz, swieze);
        return swieze;
    }

    // Wyszukiwanie po nazwie jest z natury niejednoznaczne - mnóstwo ofert
    // pasuje tekstowo, ale to inny wariant/kolor/pojemność albo akcesorium.
    // Kod EAN jednoznacznie identyfikuje DOKŁADNIE ten produkt, więc jeśli
    // go mamy, próbujemy nim najpierw (w kilku wariantach zapisu - różne
    // sklepy bywają czułe na formatowanie) - to największa realna dźwignia
    // jakości dopasowania. Dopiero gdy wyszukiwanie po EAN nic nie da (nie
    // wszystkie sklepy są zaindeksowane pod kodem EAN), wracamy do nazwy.
    let oferty = [];
    let zrodloWyszukiwania = 'nazwa';
    if (ean && ean.trim()) {
        for (const wariant of wariantyEan(ean)) {
            oferty = await wyszukajZCache(wariant);
            if (oferty.length > 0) { zrodloWyszukiwania = 'EAN'; break; }
        }
    }
    if (oferty.length === 0) {
        oferty = await wyszukajZCache(nazwaProduktu);
        zrodloWyszukiwania = 'nazwa';
    }

    // Odrzuć oferty w INNEJ walucie niż produkt - bez tego liczby z różnych
    // walut (np. $429 vs 2500 zł) byłyby porównywane wprost, jakby to była
    // ta sama waluta, co daje kompletnie fałszywy obraz.
    const wzorzecWaluty = wzorzecWalutyDlaFiltra(waluta);
    oferty = oferty.filter(o => wzorzecWaluty.test(String(o.cena)));

    // Odrzuć oferty, których tytuł wprost wskazuje na produkt UŻYWANY,
    // powystawowy, poleasingowy albo z outletu - porównywanie Twojej ceny
    // nowego produktu do ceny egzemplarza używanego jest z gruntu niesprawiedliwe
    // (cena będzie sztucznie niższa). System domyślnie zakłada, że interesuje
    // Cię konkurencja na produkty NOWE - to bezpieczniejsze domyślne założenie.
    const wzorzecUzywanego = /używany|uzywany|powystawow|poleasingow|outlet|refurbished|renewed|second\s*-?\s*hand|odnowion|po\s*zwroc|demo\b|wystawow/i;
    oferty = oferty.filter(o => !wzorzecUzywanego.test(String(o.tytul || '')));

    // Odsiej wyniki podejrzanie tanie względem reszty (typowo: etui, folie,
    // akcesoria które w tytule mają nazwę produktu głównego, ale to nie ten
    // produkt) - ZANIM w ogóle pokażemy je AI do wyboru. To główna przyczyna
    // błędnych dopasowań: AI dostawało takie pozycje bez żadnego kontekstu cen.
    const wyciagnijLiczbe = (cena) => parseFloat(String(cena).replace(/[^\d.,]/g, '').replace(',', '.'));

    const liczby = oferty
        .map(o => wyciagnijLiczbe(o.cena))
        .filter(n => !isNaN(n) && n > 0)
        .sort((a, b) => a - b);
    if (liczby.length >= 3) {
        const mediana = liczby[Math.floor(liczby.length / 2)];
        const progOdrzucenia = mediana * 0.35; // poniżej 35% mediany = prawdopodobnie inny produkt
        oferty = oferty.filter(o => {
            const cena = wyciagnijLiczbe(o.cena);
            return isNaN(cena) || cena >= progOdrzucenia;
        });
    }

    // Drugi, NIEZALEŻNY filtr - względem Twojej własnej ceny produktu, a nie
    // tylko względem mediany innych wyników. To ważne, bo mediana zawodzi gdy
    // wyników jest mało albo większość z nich to też śmieci (np. akcesoria) -
    // wtedy nawet oczywisty błąd typu "2 zł za iPhone'a" przechodzi filtr
    // powyżej. Twoja własna cena to znacznie pewniejszy punkt odniesienia:
    // prawdziwa oferta konkurencji na TEN SAM produkt nie będzie kilkadziesiąt
    // razy tańsza ani kilkadziesiąt razy droższa od Twojej ceny.
    if (twojaCena && !isNaN(parseFloat(twojaCena)) && parseFloat(twojaCena) > 0) {
        const cenaWlasna = parseFloat(twojaCena);
        const dolnyProg = cenaWlasna * 0.25;   // poniżej 25% Twojej ceny = prawie na pewno inny/niepełny produkt
        const gornyProg = cenaWlasna * 4;      // powyżej 4x Twojej ceny = prawdopodobnie zestaw/inny wariant
        oferty = oferty.filter(o => {
            const cena = wyciagnijLiczbe(o.cena);
            return isNaN(cena) || (cena >= dolnyProg && cena <= gornyProg);
        });
    }

    return { oferty, zrodloWyszukiwania };
}

async function wybierzNajlepszaOferteAI(nazwaProduktu, oferty, jezyk, twojaCena, waluta, zrodloWyszukiwania) {
    const jezykOpis = nazwaJezyka(jezyk);
    const listaOfert = oferty.map((o, i) => `${i + 1}. ${o.tytul} | Cena: ${o.cena} | Sklep: ${o.sklep}`).join('\n');
    const infoOZrodle = zrodloWyszukiwania === 'EAN'
        ? 'Poniższe wyniki pochodzą z wyszukiwania po dokładnym kodzie EAN produktu, więc powinny dotyczyć dokładnie tego samego produktu (mimo to nadal sprawdź warunki poniżej - EAN też bywa źle przypisany przez sklep).'
        : 'Poniższe wyniki pochodzą z wyszukiwania po nazwie produktu (nie znaleziono/nie użyto kodu EAN), więc dopasowanie jest mniej pewne - bądź bardziej rygorystyczny.';
    // Podajemy AI realny punkt odniesienia (Twoją własną cenę) zamiast prosić
    // je o zgadywanie "z pamięci", czy cena jest realistyczna - model nie zna
    // aktualnych cen rynkowych z dokładnością do dnia, ale potrafi dobrze
    // ocenić, czy oferta jest sensowna WZGLĘDEM podanej ceny referencyjnej.
    const referencja = twojaCena ? `Twoja własna, aktualna cena tego produktu to ${twojaCena} ${waluta || ''}. Prawdziwa oferta konkurencji na TEN SAM produkt zwykle mieści się w rozsądnym zakresie wokół tej ceny (typowo 0.5x - 2x) - jeśli którakolwiek oferta jest kilkukrotnie (np. 10x lub więcej) tańsza lub droższa niż Twoja cena, to niemal na pewno NIE jest to ten sam produkt, tylko coś innego (akcesorium, część, rata abonamentu, zestaw, pomyłka w danych źródła), NAWET jeśli tytuł oferty wygląda na pasujący.` : '';

    const prompt = `Szukamy ceny konkurencji dla produktu: "${nazwaProduktu}".
${infoOZrodle}
${referencja}

Znalezione oferty w internecie:
${listaOfert}

Wybierz JEDNĄ ofertę, która NAJLEPIEJ odpowiada dokładnie temu samemu produktowi. Zanim wybierzesz, sprawdź KAŻDĄ z poniższych rzeczy:
1. Czy to dokładnie ten sam model/wariant (nie inny rozmiar dysku, kolor, wersja)?
2. Czy tytuł oferty NIE wskazuje, że to akcesorium, etui, folia, zamiennik, część zamienna, rata/abonament albo zestaw z czymś dodatkowym, a nie sam produkt główny?
3. Czy cena mieści się w rozsądnym zakresie względem podanej ceny referencyjnej (patrz wyżej) - rażąco niższa lub wyższa cena oznacza, że to prawdopodobnie NIE jest ten sam produkt, nawet jeśli tytuł zawiera pasującą nazwę.
4. Czy tytuł oferty NIE wskazuje, że to produkt UŻYWANY, powystawowy, poleasingowy, odnowiony/refurbished albo z outletu - porównujemy WYŁĄCZNIE ceny produktów NOWYCH, chyba że nazwa Twojego produktu sama wprost mówi inaczej.

Jeśli żadna oferta nie spełnia WSZYSTKICH czterech warunków, zwróć numer -1 - lepiej nie wybrać niczego niż wybrać błędnie.

Przeanalizuj to W MYŚLACH, ale w odpowiedzi NIE PISZ żadnego rozumowania ani wyjaśnień poza samym wynikiem. Twoja odpowiedź musi składać się WYŁĄCZNIE z jednego obiektu JSON, bez żadnego tekstu przed ani po nim:
{"numer": liczba, "uzasadnienie": "BARDZO KRÓTKIE uzasadnienie (maks. 15 słów) w języku ${jezykOpis}"}`;

    return await wywolajAnthropic(prompt, 1000);
}

// ============== JEDEN, SCALONY WSKAŹNIK PEWNOŚCI ==============
// Wcześniej modal pokazywał 3-4 osobne, niezależne znaczniki (EAN/nazwa,
// zweryfikowano, rozbieżność, dostępność) - użytkownik musiał sam w głowie
// je zsumować, żeby ocenić "czy w ogóle warto zaufać tej propozycji". Ta
// funkcja robi to scalenie raz, po stronie serwera, w jedną liczbę i etykietę
// - pojedynczy sygnał do szybkiej oceny. Szczegółowe znaczniki nadal są
// dostępne w odpowiedzi (nic nie znika), po prostu przestają być JEDYNYM
// sposobem oceny pewności.
function obliczPewnoscDopasowania({ zrodloWyszukiwania, zweryfikowanoNaStronie, zrodloWeryfikacji, mozliwaRozbieznoscCen, dostepnoscOferty }) {
    let punkty = 50; // punkt startowy - "przeciętna" pewność bez żadnych dodatkowych sygnałów

    punkty += (zrodloWyszukiwania === 'EAN') ? 25 : -10;
    // Weryfikacja przez regex (dane strukturalne strony) jest obiektywna -
    // AI-fallback (Krok B) jest ostatecznością, więc dajemy mniejszy bonus,
    // żeby wskaźnik pewności uczciwie odzwierciedlał mniejszą pewność tego kroku.
    if (zweryfikowanoNaStronie) punkty += (zrodloWeryfikacji === 'ai') ? 12 : 20;
    else punkty -= 10;
    if (mozliwaRozbieznoscCen) punkty -= 30;
    if (dostepnoscOferty === 'niedostepny') punkty -= 25;
    else if (dostepnoscOferty === 'dostepny') punkty += 5;

    // Nigdy nie twierdzimy 100% ani 0% pewności - system nie ma pełnej wiedzy
    // o rzeczywistości, tylko sygnały pośrednie, więc skrajne wartości
    // byłyby fałszywą precyzją.
    punkty = Math.max(5, Math.min(95, punkty));

    let etykieta;
    if (punkty >= 75) etykieta = 'Wysoka';
    else if (punkty >= 45) etykieta = 'Średnia';
    else etykieta = 'Niska';

    return { punkty, etykieta };
}

// Cała logika wyszukania, dopasowania i zweryfikowania oferty konkurencji -
// wydzielona z endpointu, żeby ten sam, sprawdzony mechanizm mógł wywoływać
// zarówno ręczny przycisk "Znajdź automatycznie", jak i harmonogram
// automatyczny w tle (bez `req` - wtedy detectStoreContext użyje publicznego
// IP serwera zamiast IP klienta). Zwraca { success, propozycja } albo
// { success: false, error }. NIE zapisuje jeszcze niczego do produktu -
// wywołujący decyduje, co zrobić z wynikiem.
async function wyszukajIZweryfikujOferteKonkurencji(produkt, jezyk, userId, req) {
    const kontekstRynku = await detectStoreContext(userId, req);
    const targetCountry = (produkt.kraj && produkt.kraj.trim()) ? produkt.kraj.trim().toLowerCase() : kontekstRynku.targetCountry;
    const targetCurrency = (produkt.waluta && produkt.waluta !== 'AUTO') ? produkt.waluta.toUpperCase() : kontekstRynku.targetCurrency;

    const { oferty, zrodloWyszukiwania } = await pobierzOfertyZGoogleShopping(produkt.nazwa, targetCurrency, targetCountry, produkt.twoja_cena, produkt.ean);
    if (oferty.length === 0) {
        return { success: false, error: `Nie znaleziono wiarygodnych ofert dla tego produktu w walucie ${targetCurrency} (rynek: ${targetCountry.toUpperCase()}, wykryty ${kontekstRynku.zrodlo === 'sklep' ? 'z ustawień sklepu' : kontekstRynku.zrodlo === 'ip' ? 'po adresie IP' : 'domyślnie'}). Albo nic się nie znalazło, albo wszystkie znalezione wyniki odbiegały zbyt mocno cenowo od Twojego produktu i zostały odrzucone.` };
    }

    const wybor = await wybierzNajlepszaOferteAI(produkt.nazwa, oferty, jezyk, produkt.twoja_cena, targetCurrency, zrodloWyszukiwania);
    if (!wybor || typeof wybor.numer !== 'number' || wybor.numer < 1 || wybor.numer > oferty.length) {
        return { success: false, error: wybor?.uzasadnienie || 'AI nie znalazło żadnej wystarczająco pasującej oferty.' };
    }

    // Pełna lista WSZYSTKICH ofert, które przeszły filtry i zostały pokazane
    // AI do wyboru - żeby było widać, czy istniały inne (np. tańsze), i
    // dlaczego wybrano akurat tę jedną. AI ocenia dokładność dopasowania, nie
    // samą cenę, więc "najlepsza" oferta nie zawsze jest najtańszą z listy -
    // ta lista pozwala to zweryfikować zamiast zgadywać.
    const wszyscyKandydaci = oferty.map((o, i) => ({
        tytul: o.tytul,
        cena: o.cena,
        sklep: o.sklep,
        wybrana: (i + 1) === wybor.numer
    }));

    const wybrana = oferty[wybor.numer - 1];
    let cenaLiczba = parseFloat(String(wybrana.cena).replace(/[^\d.,]/g, '').replace(',', '.'));
    if (isNaN(cenaLiczba)) return { success: false, error: 'Nie udało się odczytać liczby z ceny wybranej oferty.' };

    // ŚCISŁA WERYFIKACJA WALUTY PRZEZ AI: druga, niezależna od regexów
    // warstwa - AI dostaje surowy tekst oferty i ma jawną instrukcję
    // zwrócić found:false, jeśli cena nie jest dokładnie w oczekiwanej
    // walucie rynku.
    const parsAI = await sparsujCeneAI(`${wybrana.tytul} — ${wybrana.cena}`, targetCountry, targetCurrency);
    if (!parsAI.found || typeof parsAI.price !== 'number') {
        return { success: false, error: `AI nie potwierdziło ceny tej oferty w walucie ${targetCurrency} - odrzucono, żeby nie zaproponować błędnej ceny.` };
    }

    // JEDNO pobranie strony wykorzystujemy do WSZYSTKICH poniższych celów naraz:
    // Krok A: darmowa ekstrakcja regex/JSON-LD (zero kosztu AI).
    // Krok B: JEŚLI Krok A nic nie znalazł, awaryjnie pytamy AI o cenę wprost
    // z treści strony. Po drodze też: rozbieżność cen i dostępność oferty.
    let zweryfikowanoNaStronie = false;
    let zrodloWeryfikacji = null;
    let mozliwaRozbieznoscCen = false;
    let dostepnoscOferty = 'nieznana';

    if (wybrana.link) {
        try {
            const html = await pobierzHtmlDlaDiagnostyki(wybrana.link);
            if (html) {
                mozliwaRozbieznoscCen = wykryjRozbieznoscCeny(html).rozbieznosc;
                dostepnoscOferty = wyciagnijDostepnosc(html);

                const cenaWlasna = parseFloat(produkt.twoja_cena);
                const wGranicach = (cena) => !cenaWlasna || isNaN(cenaWlasna) || (cena >= cenaWlasna * 0.25 && cena <= cenaWlasna * 4);

                const cenaZRegex = wyciagnijCeneZHtml(html);
                if (cenaZRegex !== null && cenaZRegex > 0 && wGranicach(cenaZRegex)) {
                    cenaLiczba = cenaZRegex;
                    zweryfikowanoNaStronie = true;
                    zrodloWeryfikacji = 'regex';
                } else if (cenaZRegex === null) {
                    const wynikAI = await parsujCeneZHtmlAI(html, targetCountry, targetCurrency);
                    if (wynikAI.found && typeof wynikAI.price === 'number' && wynikAI.price > 0 && wGranicach(wynikAI.price)) {
                        cenaLiczba = wynikAI.price;
                        zweryfikowanoNaStronie = true;
                        zrodloWeryfikacji = 'ai';
                    }
                }
            }
        } catch (e) { /* diagnostyka jest opcjonalna - błąd ignorujemy */ }
    }

    await dbRunAsync(`UPDATE limity_uzytkownika SET tokeny_ai = tokeny_ai - 1 WHERE user_id = ?`, [userId]);
    await dbRunAsync(
        `INSERT INTO historia_cen_konkurencji (user_id, produkt_id, cena, sklep, link, zrodlo, zweryfikowano, data, wszystkie_kandydaci_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, produkt.id, cenaLiczba.toFixed(2), wybrana.sklep, wybrana.link || '', 'Automatyczne wyszukiwanie (propozycja)', zweryfikowanoNaStronie ? 1 : 0, new Date().toLocaleString('pl-PL'), JSON.stringify(wszyscyKandydaci)]
    );

    const pewnoscDopasowania = obliczPewnoscDopasowania({ zrodloWyszukiwania, zweryfikowanoNaStronie, zrodloWeryfikacji, mozliwaRozbieznoscCen, dostepnoscOferty });
    return {
        success: true,
        propozycja: {
            tytul: wybrana.tytul,
            cena: cenaLiczba.toFixed(2),
            waluta: targetCurrency,
            sklep: wybrana.sklep,
            link: wybrana.link || '',
            uzasadnienie: wybor.uzasadnienie,
            zrodloWyszukiwania,
            zweryfikowanoNaStronie,
            zrodloWeryfikacji,
            mozliwaRozbieznoscCen,
            dostepnoscOferty,
            pewnoscDopasowania,
            wszyscyKandydaci
        }
    };
}

app.post('/api/produkty/:id/znajdz-konkurencje-automatycznie', wymagajSesji, limitAutoWyszukiwania, limitAI, sprawdzDziennyLimit, sprawdzTokenyAI, async (req, res) => {
    if (!ANTHROPIC_API_KEY) {
        return res.status(500).json({ success: false, error: 'Brak klucza ANTHROPIC_API_KEY w pliku .env.' });
    }
    const { id } = req.params;
    const jezyk = req.body.jezyk || 'pl';

    let produkt;
    try {
        produkt = await dbGetAsync(`SELECT * FROM globalne_produkty WHERE id = ? AND user_id = ?`, [id, req.session.userId]);
    } catch (e) { return res.status(500).json({ success: false, error: 'Błąd bazy danych.' }); }
    if (!produkt) return res.status(404).json({ success: false, error: 'Produkt nie istnieje.' });

    try {
        const wynik = await wyszukajIZweryfikujOferteKonkurencji(produkt, jezyk, req.session.userId, req);
        if (!wynik.success) return res.status(404).json(wynik);
        res.json({ ...wynik, tokeny_pozostale: req.tokenyPozostale - 1 });
    } catch (e) {
        console.error('Błąd automatycznego wyszukiwania konkurencji:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Zapisuje propozycję znalezioną przez /znajdz-konkurencje-automatycznie -
// wywoływane DOPIERO po Twoim ręcznym potwierdzeniu w interfejsie.
app.post('/api/produkty/:id/potwierdz-konkurencje', wymagajSesji, async (req, res) => {
    const { id } = req.params;
    const { cena, link, sklep } = req.body;
    if (!cena) return res.status(400).json({ success: false, error: 'Brak ceny do zapisania.' });

    try {
        await dbRunAsync(
            `UPDATE globalne_produkty SET cena_konkurencji = ?, url_konkurencja = ? WHERE id = ? AND user_id = ?`,
            [cena, link || '', id, req.session.userId]
        );
        await dbRunAsync(
            `INSERT INTO historia_cen_konkurencji (user_id, produkt_id, cena, sklep, link, zrodlo, zweryfikowano, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.session.userId, id, cena, sklep || '', link || '', 'Potwierdzone przez użytkownika', 1, new Date().toLocaleString('pl-PL')]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Błąd zapisu.' });
    }
});

app.put('/api/produkty/:id/kraj', wymagajSesji, (req, res) => {
    const { kraj } = req.body;
    db.run(`UPDATE globalne_produkty SET kraj = ? WHERE id = ? AND user_id = ?`, [kraj || '', req.params.id, req.session.userId], (err) => {
        if (err) return res.status(500).json({ success: false, error: 'Błąd zapisu kraju.' });
        res.json({ success: true });
    });
});

app.put('/api/produkty/:id/url-konkurencji', wymagajSesji, (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'Podaj adres URL.' });
    db.run(`UPDATE globalne_produkty SET url_konkurencja = ? WHERE id = ? AND user_id = ?`, [url, req.params.id, req.session.userId], (err) => {
        if (err) return res.status(500).json({ success: false, error: 'Błąd zapisu linku.' });
        res.json({ success: true });
    });
});

app.post('/api/produkty/:id/pobierz-cene-konkurencji', wymagajSesji, async (req, res) => {
    const { id } = req.params;
    const userId = req.session.userId;
    let produkt;
    try {
        produkt = await dbGetAsync(`SELECT * FROM globalne_produkty WHERE id = ? AND user_id = ?`, [id, userId]);
    } catch (e) { return res.status(500).json({ success: false, error: 'Błąd bazy danych.' }); }
    if (!produkt) return res.status(404).json({ success: false, error: 'Produkt nie istnieje.' });
    if (!produkt.url_konkurencja) return res.status(400).json({ success: false, error: 'Najpierw dodaj link do oferty konkurencji.' });

    try {
        // Ten sam kontekst rynku, co przy automatycznym wyszukiwaniu - żeby
        // Krok B (awaryjny parser AI, patrz pobierzCeneZeStrony) wiedział, w
        // jakiej walucie ma szukać ceny, nawet gdy produkt ma "AUTO" albo
        // pustą walutę.
        const kontekstRynku = await detectStoreContext(userId, req);
        const targetCountry = (produkt.kraj && produkt.kraj.trim()) ? produkt.kraj.trim().toLowerCase() : kontekstRynku.targetCountry;
        const targetCurrency = (produkt.waluta && produkt.waluta !== 'AUTO') ? produkt.waluta.toUpperCase() : kontekstRynku.targetCurrency;

        const cena = await pobierzCeneZeStrony(produkt.url_konkurencja, targetCountry, targetCurrency);
        const cenaStr = cena.toFixed(2);
        db.run(`UPDATE globalne_produkty SET cena_konkurencji = ? WHERE id = ?`, [cenaStr, id]);
        await dbRunAsync(
            `INSERT INTO historia_cen_konkurencji (user_id, produkt_id, cena, sklep, link, zrodlo, zweryfikowano, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, id, cenaStr, '', produkt.url_konkurencja, 'Ręczne pobranie z linku', 1, new Date().toLocaleString('pl-PL')]
        );
        res.json({ success: true, cena_konkurencji: cenaStr });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/historia-cen-konkurencji/:id', wymagajSesji, (req, res) => {
    db.all(
        `SELECT * FROM historia_cen_konkurencji WHERE produkt_id = ? AND user_id = ? ORDER BY id DESC`,
        [req.params.id, req.session.userId],
        (err, rows) => res.json(rows || [])
    );
});

app.get('/api/globalne-produkty', wymagajSesji, (req, res) => {
    db.all(`SELECT * FROM globalne_produkty WHERE user_id = ? ORDER BY id DESC`, [req.session.userId], (err, rows) => {
        res.json(rows || []);
    });
});

// ============== PRAWDZIWE STATYSTYKI SPRZEDAŻY (z WooCommerce) ==============
// Sprzedaż liczymy z realnych zamówień pobranych z WooCommerce - to twarda
// liczba. Zysk to UCZCIWIE zaznaczony SZACUNEK: system nie zna prawdziwego
// kosztu zakupu produktów (nikt go nigdzie nie wpisuje), więc jako przybliżenie
// kosztu używa Floor Price (75% Twojej ceny) TYLKO dla produktów, które da się
// dopasować do zamówienia po woo_produkt_id. Pozycje w zamówieniu, których nie
// da się dopasować do żadnego produktu w systemie, liczą się do przychodu, ale
// NIE do zysku (bo nie mamy żadnej podstawy do oszacowania ich kosztu).
const cacheStatystyk = new Map(); // user_id -> { dane, wygasa }
const TTL_CACHE_STATYSTYK_MS = 5 * 60 * 1000; // 5 min - żeby nie odpytywać WooCommerce przy każdym odświeżeniu dashboardu

async function pobierzZamowieniaWooCommerce(storeUrl, consumerKey, consumerSecret, after, before) {
    const bazowyUrl = storeUrl.trim().replace(/\/+$/, '');
    const authHeader = 'Basic ' + Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    let wszystkie = [];
    const MAX_STRON = 5; // bezpiecznik - maks. 500 zamówień na okres, żeby nie zawiesić się na gigantycznym sklepie
    for (let strona = 1; strona <= MAX_STRON; strona++) {
        const url = `${bazowyUrl}/wp-json/wc/v3/orders?per_page=100&page=${strona}&after=${encodeURIComponent(after)}&before=${encodeURIComponent(before)}&status=completed,processing`;
        let res;
        try {
            res = await fetch(url, { headers: { Authorization: authHeader } });
        } catch (e) { break; }
        if (!res.ok) break;
        const dane = await res.json();
        if (!Array.isArray(dane) || dane.length === 0) break;
        wszystkie = wszystkie.concat(dane);
        if (dane.length < 100) break;
    }
    return wszystkie;
}

// Wersja BEZ filtra statusu - w przeciwieństwie do powyższej (używanej do
// statystyk sprzedaży, gdzie liczy się tylko opłacone/realizowane zamówienia)
// ta pobiera zamówienia w KAŻDYM statusie, bo zakładka "Zamówienia" ma
// pokazywać wszystko, co dzieje się w sklepie - w tym nowe, jeszcze
// nieopłacone czy anulowane, nie tylko te wliczane do przychodu.
async function pobierzWszystkieZamowieniaWooCommerce(storeUrl, consumerKey, consumerSecret, after) {
    const bazowyUrl = storeUrl.trim().replace(/\/+$/, '');
    const authHeader = 'Basic ' + Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    let wszystkie = [];
    const MAX_STRON = 5;
    for (let strona = 1; strona <= MAX_STRON; strona++) {
        const url = `${bazowyUrl}/wp-json/wc/v3/orders?per_page=100&page=${strona}&after=${encodeURIComponent(after)}`;
        let res;
        try {
            res = await fetch(url, { headers: { Authorization: authHeader } });
        } catch (e) { break; }
        if (!res.ok) break;
        const dane = await res.json();
        if (!Array.isArray(dane) || dane.length === 0) break;
        wszystkie = wszystkie.concat(dane);
        if (dane.length < 100) break;
    }
    return wszystkie;
}

async function obliczStatystykiOkresu(userId, storeUrl, consumerKey, consumerSecret, after, before) {
    const zamowienia = await pobierzZamowieniaWooCommerce(storeUrl, consumerKey, consumerSecret, after, before);
    const produkty = await dbAllAsync(`SELECT woo_produkt_id, twoja_cena, floor_price_procent FROM globalne_produkty WHERE user_id = ? AND woo_produkt_id IS NOT NULL`, [userId]);
    const konfiguracja = await dbGetAsync(`SELECT floor_price_procent FROM konfiguracja WHERE user_id = ?`, [userId]);
    const floorMap = new Map(produkty.map(p => [p.woo_produkt_id, obliczFloorPrice(p, konfiguracja)]));

    let sprzedaz = 0;
    let zysk = 0;
    for (const zam of zamowienia) {
        const total = parseFloat(zam.total || '0');
        if (!isNaN(total)) sprzedaz += total;
        for (const item of (zam.line_items || [])) {
            const floor = floorMap.get(item.product_id);
            const lineTotal = parseFloat(item.total || '0');
            if (floor !== undefined && !isNaN(lineTotal)) {
                zysk += lineTotal - (floor * (item.quantity || 1));
            }
        }
    }
    return { sprzedaz: sprzedaz.toFixed(2), zysk: zysk.toFixed(2) };
}

// Status ostatniego/aktualnego przebiegu harmonogramu dla bieżącego
// użytkownika - żeby UI mogło pokazać realny postęp ("sprawdzono 43 z 150")
// zamiast czarnej skrzynki działającej gdzieś w tle.
app.get('/api/harmonogram/status', wymagajSesji, (req, res) => {
    db.get(
        `SELECT * FROM przebiegi_harmonogramu WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
        [req.session.userId],
        (err, wiersz) => res.json(wiersz || null)
    );
});

app.get('/api/statystyki', wymagajSesji, async (req, res) => {
    const userId = req.session.userId;

    const zCache = cacheStatystyk.get(userId);
    if (zCache && Date.now() < zCache.wygasa) {
        return res.json(zCache.dane);
    }

    try {
        const konfiguracja = await dbGetAsync(`SELECT store_url, consumer_key, consumer_secret, waluta FROM konfiguracja WHERE user_id = ?`, [userId]);
        if (!konfiguracja || !konfiguracja.store_url || !konfiguracja.consumer_key || !konfiguracja.consumer_secret) {
            return res.json([]); // brak podłączonego sklepu - brak danych sprzedażowych do policzenia
        }
        konfiguracja.consumer_key = odszyfrujSekret(konfiguracja.consumer_key);
        konfiguracja.consumer_secret = odszyfrujSekret(konfiguracja.consumer_secret);

        const teraz = new Date();
        const poczatekMiesiaca = new Date(teraz.getFullYear(), teraz.getMonth(), 1);
        const poczatekPoprzedniegoMiesiaca = new Date(teraz.getFullYear(), teraz.getMonth() - 1, 1);
        const koniecPoprzedniegoMiesiaca = new Date(poczatekMiesiaca.getTime() - 1);
        const siedemDniTemu = new Date(teraz.getTime() - 7 * 24 * 60 * 60 * 1000);
        const czternascieDniTemu = new Date(teraz.getTime() - 14 * 24 * 60 * 60 * 1000);

        const [miesiac, poprzedniMiesiac, tydzien, poprzedniTydzien] = await Promise.all([
            obliczStatystykiOkresu(userId, konfiguracja.store_url, konfiguracja.consumer_key, konfiguracja.consumer_secret, poczatekMiesiaca.toISOString(), teraz.toISOString()),
            obliczStatystykiOkresu(userId, konfiguracja.store_url, konfiguracja.consumer_key, konfiguracja.consumer_secret, poczatekPoprzedniegoMiesiaca.toISOString(), koniecPoprzedniegoMiesiaca.toISOString()),
            obliczStatystykiOkresu(userId, konfiguracja.store_url, konfiguracja.consumer_key, konfiguracja.consumer_secret, siedemDniTemu.toISOString(), teraz.toISOString()),
            obliczStatystykiOkresu(userId, konfiguracja.store_url, konfiguracja.consumer_key, konfiguracja.consumer_secret, czternascieDniTemu.toISOString(), siedemDniTemu.toISOString())
        ]);

        const wynik = [
            { okres: 'miesiac', waluta: konfiguracja.waluta || 'PLN', sprzedaz: miesiac.sprzedaz, zysk: miesiac.zysk, poprzedni_sprzedaz: poprzedniMiesiac.sprzedaz, poprzedni_zysk: poprzedniMiesiac.zysk },
            { okres: 'tydzien', waluta: konfiguracja.waluta || 'PLN', sprzedaz: tydzien.sprzedaz, zysk: tydzien.zysk, poprzedni_sprzedaz: poprzedniTydzien.sprzedaz, poprzedni_zysk: poprzedniTydzien.zysk }
        ];
        cacheStatystyk.set(userId, { dane: wynik, wygasa: Date.now() + TTL_CACHE_STATYSTYK_MS });
        res.json(wynik);
    } catch (e) {
        console.error('Błąd pobierania statystyk:', e.message);
        res.json([]); // błąd nie może wywalić całego dashboardu - po prostu brak danych
    }
});

// ============== PRAWDZIWE AI (Claude) - SUGESTIA CENOWA ==============
const GODZIN_WAZNOSCI_SUGESTII = 24; // "domyślnie AI sprawdza 1 na dobę"

function czyMoznaUzycCache(produkt) {
    if (!produkt.sugerowana_cena || !produkt.ai_ostatnio_sprawdzono) return false;
    const cenaSieNieZmienila = produkt.ai_sprawdzona_cena_konkurencji === produkt.cena_konkurencji;
    const godzinyOdSprawdzenia = (Date.now() - new Date(produkt.ai_ostatnio_sprawdzono).getTime()) / (1000 * 60 * 60);
    // Optymalizacja kosztów: jeśli cena konkurencji się nie zmieniła ODKĄD AI ostatnio
    // sprawdzało ten produkt, LUB minęło mniej niż 24h - nie płacimy za kolejne zapytanie,
    // tylko oddajemy poprzednią, wciąż aktualną sugestię.
    return cenaSieNieZmienila || godzinyOdSprawdzenia < GODZIN_WAZNOSCI_SUGESTII;
}

function nazwaJezyka(jezyk) {
    return { pl: 'polskim', en: 'English', es: 'español', de: 'Deutsch', fr: 'français' }[jezyk] || 'polskim';
}

// ============== FLOOR PRICE - KONFIGUROWALNY PROCENT (nie sztywne 75%) ==============
// Priorytet: (1) własne ustawienie NA PRODUKCIE (jeśli ustawione), (2)
// globalne ustawienie użytkownika w konfiguracji, (3) domyślne 75%, jeśli
// żadne z powyższych nie jest ustawione (np. konto sprzed tej funkcji).
// Wcześniej to było wpisane na sztywno w 14 różnych miejscach kodu - błąd,
// bo różne produkty mają różne marże (np. koszt 100 zł, cena sprzedaży 120 zł
// -> sztywne 75% dałoby Floor Price = 90 zł, czyli PONIŻEJ kosztu zakupu).
function obliczProcentFloorPrice(produkt, konfiguracja) {
    if (produkt && produkt.floor_price_procent !== null && produkt.floor_price_procent !== undefined) {
        return parseFloat(produkt.floor_price_procent);
    }
    if (konfiguracja && konfiguracja.floor_price_procent !== null && konfiguracja.floor_price_procent !== undefined) {
        return parseFloat(konfiguracja.floor_price_procent);
    }
    return 75;
}

function obliczFloorPrice(produkt, konfiguracja) {
    const procent = obliczProcentFloorPrice(produkt, konfiguracja);
    return parseFloat(produkt.twoja_cena) * (procent / 100);
}

// ============== REGUŁY CENOWE (alternatywa dla AI - szybka, darmowa) ==============
// Nie każdy chce płacić tokenami AI za każdą sugestię - część użytkowników
// woli prostą, przewidywalną regułę matematyczną. Floor Price jest
// respektowany ZAWSZE, niezależnie od trybu - to twardy limit bezpieczeństwa
// marży, który reguły też muszą uszanować.
//
// Zwraca { sugerowana_cena, uzasadnienie } tak samo jak funkcje AI poniżej,
// żeby dało się ich używać zamiennie w tych samych miejscach kodu - ALBO
// null, jeśli reguły nie da się policzyć (np. brak znanej ceny konkurencji).
function obliczCeneRegulowa(produkt, tryb, wartosc, konfiguracja) {
    const twojaCena = parseFloat(produkt.twoja_cena);
    const cenaKonkurencji = produkt.cena_konkurencji ? parseFloat(produkt.cena_konkurencji) : null;
    const floorPrice = obliczFloorPrice(produkt, konfiguracja);
    if (!cenaKonkurencji || isNaN(cenaKonkurencji) || cenaKonkurencji <= 0) return null; // reguły oparte o konkurencję wymagają jej znanej ceny

    let sugerowana;
    let opis;
    if (tryb === 'PROCENT_PONIZEJ_KONKURENCJI') {
        const procent = (typeof wartosc === 'number' && wartosc > 0) ? wartosc : 5;
        sugerowana = cenaKonkurencji * (1 - procent / 100);
        opis = `Reguła: ${procent}% poniżej ceny konkurencji (${cenaKonkurencji.toFixed(2)} ${produkt.waluta}).`;
    } else if (tryb === 'DOPASUJ_KONKURENCJE') {
        sugerowana = cenaKonkurencji;
        opis = `Reguła: dopasowanie do ceny konkurencji (${cenaKonkurencji.toFixed(2)} ${produkt.waluta}).`;
    } else {
        return null; // nieznany tryb - wywołujący powinien wrócić do AI
    }

    if (sugerowana < floorPrice) {
        sugerowana = floorPrice;
        opis += ` Ograniczono do Floor Price (${floorPrice.toFixed(2)} ${produkt.waluta}), żeby nie zejść poniżej minimalnej marży.`;
    }
    return { sugerowana_cena: sugerowana, uzasadnienie: opis };
}

async function poprosAIOSugestieJednegoProduktu(produkt, jezyk) {
    const twojaCena = parseFloat(produkt.twoja_cena);
    const cenaKonkurencji = produkt.cena_konkurencji ? parseFloat(produkt.cena_konkurencji) : null;
    const procentFloor = (produkt.floor_price_procent !== null && produkt.floor_price_procent !== undefined) ? produkt.floor_price_procent : 75;
    const floorPrice = (twojaCena * (procentFloor / 100)).toFixed(2);
    const jezykOpis = nazwaJezyka(jezyk);

    const prompt = `Jesteś doświadczonym analitykiem cenowym e-commerce. Oceń poniższy produkt i zaproponuj sugerowaną cenę sprzedaży.

Dane produktu:
- Nazwa: ${produkt.nazwa}
- Twoja obecna cena: ${twojaCena} ${produkt.waluta}
- Cena konkurencji: ${cenaKonkurencji !== null ? cenaKonkurencji + ' ' + produkt.waluta : 'brak danych'}
- Minimalna akceptowalna cena (floor price, nie schodzić poniżej): ${floorPrice} ${produkt.waluta}

Zaproponuj sugerowaną cenę sprzedaży (liczba, w tej samej walucie, nie niższa niż floor price) i napisz krótkie (2-3 zdania) uzasadnienie biznesowe tej decyzji NAPISANE W JĘZYKU: ${jezykOpis}.

Odpowiedz WYŁĄCZNIE w formacie JSON, bez żadnego dodatkowego tekstu przed ani po:
{"sugerowana_cena": liczba, "uzasadnienie": "tekst uzasadnienia w języku ${jezykOpis}"}`;

    const wynik = await wywolajAnthropic(prompt, 300);
    if (typeof wynik.sugerowana_cena !== 'number' || !wynik.uzasadnienie) {
        throw new Error('Odpowiedź AI nie zawiera oczekiwanych pól.');
    }
    return wynik;
}

// Zapytanie WSADOWE - jeden request obejmujący wiele produktów naraz, zamiast
// osobnego zapytania na każdy z nich. Płacisz raz za "narzut" instrukcji
// (prompt), a nie N razy - to jest realna oszczędność kosztów przy większej
// liczbie produktów.
async function poprosAIOSugestieWsadowo(produkty, jezyk) {
    const jezykOpis = nazwaJezyka(jezyk);
    const listaProduktow = produkty.map((p, i) => {
        const twojaCena = parseFloat(p.twoja_cena);
        const cenaKonkurencji = p.cena_konkurencji ? parseFloat(p.cena_konkurencji) : null;
        const procentFloor = (p.floor_price_procent !== null && p.floor_price_procent !== undefined) ? p.floor_price_procent : 75;
        const floorPrice = (twojaCena * (procentFloor / 100)).toFixed(2);
        return `${i + 1}. id=${p.id} | Nazwa: ${p.nazwa} | Twoja cena: ${twojaCena} ${p.waluta} | Cena konkurencji: ${cenaKonkurencji !== null ? cenaKonkurencji + ' ' + p.waluta : 'brak danych'} | Floor Price: ${floorPrice} ${p.waluta}`;
    }).join('\n');

    const prompt = `Jesteś doświadczonym analitykiem cenowym e-commerce. Oceń KAŻDY z poniższych produktów osobno i zaproponuj dla każdego sugerowaną cenę sprzedaży.

Produkty:
${listaProduktow}

Dla KAŻDEGO produktu zaproponuj sugerowaną cenę (liczba, nie niższa niż jego Floor Price) i krótkie (1-2 zdania) uzasadnienie NAPISANE W JĘZYKU: ${jezykOpis}.

Odpowiedz WYŁĄCZNIE w formacie JSON - tablicą obiektów, bez żadnego dodatkowego tekstu przed ani po:
[{"id": liczba, "sugerowana_cena": liczba, "uzasadnienie": "tekst"}, ...]`;

    const wynik = await wywolajAnthropic(prompt, 200 * produkty.length + 200);
    if (!Array.isArray(wynik)) throw new Error('Odpowiedź AI nie jest tablicą.');
    return wynik;
}

async function wywolajAnthropic(prompt, maxTokens) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] })
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Anthropic API zwróciło błąd ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const tekst = (data.content || []).map(blok => blok.text || '').join('').trim();
    let oczyszczony = tekst.replace(/```json/gi, '').replace(/```/g, '').trim();

    try {
        return JSON.parse(oczyszczony);
    } catch (e) {
        // Model mógł dopisać tekst przed/po właściwym JSON mimo instrukcji -
        // spróbuj wyłuskać sam obiekt/tablicę JSON z całej odpowiedzi, zanim
        // ostatecznie się poddamy.
        const dopasowanie = oczyszczony.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
        if (dopasowanie) {
            try {
                return JSON.parse(dopasowanie[1]);
            } catch (e2) { /* dalej się nie udało - poddajemy się poniżej */ }
        }
        throw new Error('Nie udało się odczytać odpowiedzi AI (niepoprawny JSON): ' + tekst);
    }
}

// Ścisły parser cen AI - druga, niezależna warstwa weryfikacji OBOK filtrów
// regexowych (wzorzecWalutyDlaFiltra). Dostaje surowy tekst oferty (tytuł +
// cena) oraz wykryty kontekst rynku (targetCountry/targetCurrency) i ma
// jeden cel: potwierdzić, że cena faktycznie jest w oczekiwanej walucie -
// jeśli nie jest pewien, ma zwrócić found:false zamiast zgadywać.
async function sparsujCeneAI(tekstOferty, targetCountry, targetCurrency) {
    const prompt = `Jesteś precyzyjnym parserem cen e-commerce dla rynku ${String(targetCountry).toUpperCase()}. Twój cel to wyciągnięcie ceny w walucie ${targetCurrency}.

ZASADY STRICT:
- Wyciągaj cenę TYLKO wtedy, gdy zgadza się z walutą ${targetCurrency}.
- Jeśli w dostarczonym tekście cena jest podana w innej walucie lub jej brakuje, zwróć null.
- Zwróć wynik WYŁĄCZNIE w formacie JSON, bez żadnego dodatkowego tekstu przed ani po: {"price": liczba_lub_null, "currency": "${targetCurrency}", "found": true_lub_false}

Tekst do przeanalizowania: "${tekstOferty}"`;

    try {
        const wynik = await wywolajAnthropic(prompt, 200);
        if (!wynik || typeof wynik.found !== 'boolean') return { price: null, currency: targetCurrency, found: false };
        return wynik;
    } catch (e) {
        // Błąd AI (np. limit API) traktujemy jako "nie znaleziono", nie jako
        // twardy błąd całej operacji - jest to dodatkowa warstwa pewności,
        // nie jedyne źródło prawdy.
        return { price: null, currency: targetCurrency, found: false };
    }
}

// KROK B pipeline'u: awaryjny parser AI, wywoływany WYŁĄCZNIE gdy Krok A
// (darmowa ekstrakcja regex/JSON-LD w wyciagnijCeneZHtml) nie znajdzie
// żadnej ceny. To jedyne miejsce w całym mechanizmie weryfikacji, gdzie AI
// dostaje surowy HTML zamiast krótkiego, już przetworzonego tekstu - dlatego
// mocno ograniczamy rozmiar (usuwamy tagi/skrypty, przycinamy) i trzymamy
// się tego samego rygorystycznego schematu JSON co reszta walidacji cenowej.
async function parsujCeneZHtmlAI(html, targetCountry, targetCurrency) {
    const tekstWidoczny = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 4000); // limit - to Krok AWARYJNY, nie chcemy płacić za analizę całej strony

    if (!tekstWidoczny) return { price: null, currency: targetCurrency, found: false };

    const prompt = `Jesteś precyzyjnym parserem danych e-commerce dla rynku ${String(targetCountry).toUpperCase()} i waluty ${targetCurrency}.

ZASADY STRICT:
1. Wyciągaj aktualną cenę produktu TYLKO wtedy, gdy zgadza się z walutą ${targetCurrency}.
2. Jeśli cena jest w innej walucie, brakuje jej, albo masz jakiekolwiek wątpliwości, zwróć null. NIGDY nie zgaduj, nie szacuj i nie przeliczaj walut na własną rękę.
3. Zwróć wynik WYŁĄCZNIE w formacie JSON, bez żadnego tekstu przed ani po: {"price": liczba_lub_null, "currency": "${targetCurrency}", "found": true_lub_false}

Fragment treści strony do przeanalizowania:
"""
${tekstWidoczny}
"""`;

    try {
        const wynik = await wywolajAnthropic(prompt, 200);
        if (!wynik || typeof wynik.found !== 'boolean') return { price: null, currency: targetCurrency, found: false };
        return wynik;
    } catch (e) {
        return { price: null, currency: targetCurrency, found: false };
    }
}

async function wywolajAnthropicTekst(prompt, maxTokens) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] })
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Anthropic API zwróciło błąd ${res.status}: ${errText}`);
    }

    const data = await res.json();
    return (data.content || []).map(blok => blok.text || '').join('').trim();
}

// ============== ASYSTENT POMOCY (wbudowany w aplikację) ==============
// Odpowiada na pytania klientów o to, jak działa aplikacja - działa jak
// "pierwsza linia wsparcia", zna wszystkie funkcje PriceAI Cloud. Osobny
// limit (limitAsystenta) - nie zużywa płatnej puli tokenów do sugestii cenowych.
const WIEDZA_O_APLIKACJI = `Jesteś asystentem pomocy technicznej aplikacji "PriceAI Cloud" - narzędzia do automatycznego zarządzania cenami w e-commerce. Znasz dokładnie jak działa aplikacja:

FUNKCJE APLIKACJI:
- Zakładka "Repricer & Ceny AI": lista produktów, dla każdego widać Twoją cenę, cenę konkurencji, sugerowaną cenę AI i rekomendację z uzasadnieniem.
- "Floor Price" to najniższa dopuszczalna cena produktu - system nigdy nie zasugeruje ceny niższej. Procent jest KONFIGUROWALNY: domyślny procent ustawia się globalnie w panelu konfiguracji (pole "Domyślny procent Floor Price"), a dla pojedynczego produktu można go nadpisać indywidualnie ikonką ✏️ obok wartości Floor Price w tabeli (przydatne przy produktach o innej marży).
- Przycisk "Generuj sugestię AI" przy produkcie - model AI analizuje Twoją cenę i cenę konkurencji, proponuje nową cenę z uzasadnieniem, respektując Floor Price.
- "Znajdź automatycznie" - AI samo szuka oferty konkurencji w internecie (Google Shopping, a dla Polski dodatkowo Ceneo i Allegro, dla kilku krajów UE dodatkowo Idealo), dopasowuje najlepszy produkt, i pokazuje wskaźnik pewności dopasowania (Niska/Średnia/Wysoka) - zawsze wymaga Twojego ręcznego potwierdzenia przed zapisaniem.
- "Dodaj link" przy konkurencji + "Pobierz cenę" - ręczne pobieranie ceny konkurencji z konkretnego, wskazanego linku.
- Harmonogram automatyczny: można ustawić godzinę, o której system sam (bez klikania) odświeża ceny konkurencji, szuka konkurencji dla produktów bez linku (przy wystarczającej pewności dopasowania), liczy sugestie AI i zatwierdza nowe ceny - włącza się przełącznikiem "Codzienna automatyczna aplikacja cen". Jeśli nowo policzona cena jest identyczna z obecną, system nic nie zmienia (nie zaśmieca historii).
- Tryb wyliczania cen: AI (pełna analiza modelem, kosztuje token) ALBO darmowa reguła matematyczna (% poniżej konkurencji / dopasuj cenę konkurencji, zero tokenów) - przełącznik w konfiguracji.
- Integracje sklepowe - TRZY opcje do wyboru w panelu konfiguracji: WooCommerce (adres sklepu + Consumer Key/Secret z Ustawień REST API), Shopify (domena sklepu + token dostępu Admin API), albo dowolny inny system przez ręczny import/eksport CSV (zakładka Szybka Synchronizacja).
- Zakładki: Zamówienia (synchronizowane automatycznie z prawdziwym sklepem przy połączeniu WooCommerce/Shopify), Stany Magazynowe (też zsynchronizowane), Katalog Produktów, Szybka Synchronizacja (przycisk "Uruchom Sync" ręcznie odświeża wszystko, "Reset do Bazowych" przywraca ceny sprzed jakiejkolwiek automatycznej zmiany).
- Plany: DEMO (tymczasowe, znika po zamknięciu przeglądarki), FREE (10 produktów), STARTER (50 produktów, 49 zł/mies.), PRO (300 produktów, 299 zł/mies.), BUSINESS (1500 produktów, 1490 zł/mies.), SCALE (5000 produktów, 4900 zł/mies.), ENTERPRISE (10000 produktów, 9900 zł/mies.) - wszystkie płatne plany mają tokenów AI dokładnie tyle, żeby starczyło na codzienną, pełną automatyzację AI przez cały miesiąc. Tokeny AI zużywają się przy sugestiach cenowych i automatycznym wyszukiwaniu konkurencji (ale NIE przy pytaniach do Ciebie - jesteś osobnym, darmowym mechanizmem), i NIE zużywają się w trybie regułowym.
- Log zmian cen: przycisk "Log zmian" przy produkcie pokazuje historię wszystkich zmian jego ceny.
- Eksport CSV, wyszukiwanie, filtrowanie, sortowanie tabeli produktów.

ZASADY ODPOWIADANIA:
- Odpowiadaj krótko, konkretnie, po polsku (chyba że użytkownik pisze w innym języku - wtedy odpowiedz w jego języku).
- Jeśli pytanie dotyczy czegoś spoza tej aplikacji, uprzejmie powiedz że możesz pomóc tylko z PriceAI Cloud.
- Jeśli nie wiesz jak coś rozwiązać, zasugeruj kontakt z prawdziwym wsparciem.
- Nigdy nie zmyślaj funkcji, których nie ma na powyższej liście.`;

app.post('/api/asystent', wymagajSesji, limitAsystenta, async (req, res) => {
    if (!ANTHROPIC_API_KEY) {
        return res.status(500).json({ success: false, error: 'Asystent AI jest chwilowo niedostępny.' });
    }
    const { pytanie, historia } = req.body;
    if (!pytanie || !pytanie.trim()) {
        return res.status(400).json({ success: false, error: 'Wpisz pytanie.' });
    }

    const kontekstHistorii = Array.isArray(historia)
        ? historia.slice(-6).map(h => `${h.rola === 'user' ? 'Użytkownik' : 'Asystent'}: ${h.tresc}`).join('\n')
        : '';

    const prompt = `${WIEDZA_O_APLIKACJI}

${kontekstHistorii ? `Wcześniejsza rozmowa:\n${kontekstHistorii}\n` : ''}
Pytanie użytkownika: ${pytanie.trim()}

Odpowiedz krótko i konkretnie (maks. 4-5 zdań), bez formatowania markdown.`;

    try {
        const odpowiedz = await wywolajAnthropicTekst(prompt, 400);
        res.json({ success: true, odpowiedz });
    } catch (e) {
        console.error('Błąd asystenta AI:', e.message);
        res.status(500).json({ success: false, error: 'Błąd asystenta AI: ' + e.message });
    }
});

// Middleware: sprawdza czy użytkownik ma jeszcze darmowe tokeny AI, zanim
// w ogóle spróbujemy czegokolwiek liczyć.
function sprawdzTokenyAI(req, res, next) {
    db.get(`SELECT tokeny_ai FROM limity_uzytkownika WHERE user_id = ?`, [req.session.userId], (err, wiersz) => {
        const tokeny = wiersz ? wiersz.tokeny_ai : DOMYSLNE_TOKENY_AI;
        if (tokeny <= 0) {
            return res.status(402).json({
                success: false,
                error: 'Wykorzystałeś darmowe analizy AI. Przejdź na plan Pro, aby kontynuować automatyzację.',
                limit_tokenow: true
            });
        }
        req.tokenyPozostale = tokeny;
        next();
    });
}

app.post('/api/ai-sugestia/:id', wymagajSesji, limitAI, sprawdzDziennyLimit, async (req, res) => {
    const { id } = req.params;
    const jezyk = (req.body && req.body.jezyk) || 'pl';
    const userId = req.session.userId;

    let produkt;
    try {
        produkt = await dbGetAsync(`SELECT * FROM globalne_produkty WHERE id = ? AND user_id = ?`, [id, userId]);
    } catch (e) { return res.status(500).json({ success: false, error: 'Błąd bazy danych.' }); }
    if (!produkt) return res.status(404).json({ success: false, error: 'Produkt nie istnieje.' });

    if (czyMoznaUzycCache(produkt)) {
        return res.json({ success: true, sugerowana_cena: produkt.sugerowana_cena, uzasadnienie: produkt.rekomendacja, zbuforowane: true });
    }

    // TRYB REGUŁOWY: darmowa, natychmiastowa alternatywa dla AI - nie zużywa
    // tokenów, nie wymaga klucza Anthropic. Sprawdzana PRZED jakimkolwiek
    // limitem/kosztem AI, właśnie po to, żeby ktoś bez tokenów nadal mógł
    // z tego korzystać.
    let konfiguracja;
    try { konfiguracja = await dbGetAsync(`SELECT tryb_cenowy, wartosc_reguly, ceny_zawieraja_vat, stawka_vat, floor_price_procent FROM konfiguracja WHERE user_id = ?`, [userId]); } catch (e) { /* brak konfiguracji = tryb AI domyślnie */ }
    const trybCenowy = konfiguracja?.tryb_cenowy || 'AI';

    if (trybCenowy !== 'AI') {
        const wynikReguly = obliczCeneRegulowa(produktZDostosowanaCenaKonkurencji(produkt, konfiguracja), trybCenowy, konfiguracja?.wartosc_reguly, konfiguracja);
        if (!wynikReguly) {
            return res.status(400).json({ success: false, error: 'Nie można policzyć ceny regułą - brak znanej ceny konkurencji dla tego produktu. Pobierz/dodaj cenę konkurencji albo przełącz się na tryb AI w konfiguracji.' });
        }
        const cenaStr = wynikReguly.sugerowana_cena.toFixed(2);
        await dbRunAsync(
            `UPDATE globalne_produkty SET sugerowana_cena = ?, rekomendacja = ?, ai_sprawdzona_cena_konkurencji = ?, ai_ostatnio_sprawdzono = ? WHERE id = ?`,
            [cenaStr, wynikReguly.uzasadnienie, produkt.cena_konkurencji, new Date().toISOString(), id]
        );
        const floorPrice = obliczFloorPrice(produkt, konfiguracja);
        if (wynikReguly.sugerowana_cena <= floorPrice) {
            await dodajPowiadomienie(userId, 'floor_price', `Sugerowana cena (reguła) dla "${produkt.nazwa}" jest na poziomie Floor Price lub poniżej - sprawdź przed zatwierdzeniem.`, produkt.id);
        }
        return res.json({ success: true, sugerowana_cena: cenaStr, uzasadnienie: wynikReguly.uzasadnienie, zbuforowane: false, regula: true });
    }

    // TRYB AI - od tego miejsca w dół zachowanie identyczne jak dotychczas.
    if (!ANTHROPIC_API_KEY) {
        return res.status(500).json({ success: false, error: 'Brak klucza ANTHROPIC_API_KEY w pliku .env.' });
    }
    let limity;
    try { limity = await dbGetAsync(`SELECT tokeny_ai FROM limity_uzytkownika WHERE user_id = ?`, [userId]); } catch (e) {}
    const tokenyPozostale = limity ? limity.tokeny_ai : DOMYSLNE_TOKENY_AI;
    if (tokenyPozostale <= 0) {
        return res.status(402).json({ success: false, error: 'Wykorzystałeś darmowe analizy AI. Przejdź na plan Pro, aby kontynuować automatyzację (albo przełącz się na darmowy tryb regułowy w konfiguracji).', limit_tokenow: true });
    }

    try {
        const wynik = await poprosAIOSugestieJednegoProduktu(produktZDostosowanaCenaKonkurencji(produkt, konfiguracja), jezyk);
        const sugerowanaCenaStr = wynik.sugerowana_cena.toFixed(2);
        const teraz = new Date().toISOString();

        db.run(
            `UPDATE globalne_produkty SET sugerowana_cena = ?, rekomendacja = ?, ai_sprawdzona_cena_konkurencji = ?, ai_ostatnio_sprawdzono = ? WHERE id = ?`,
            [sugerowanaCenaStr, wynik.uzasadnienie, produkt.cena_konkurencji, teraz, id]
        );
        db.run(`UPDATE limity_uzytkownika SET tokeny_ai = tokeny_ai - 1 WHERE user_id = ?`, [userId]);

        const floorPrice = obliczFloorPrice(produkt, konfiguracja);
        if (wynik.sugerowana_cena <= floorPrice) {
            await dodajPowiadomienie(userId, 'floor_price', `Sugerowana cena AI dla "${produkt.nazwa}" jest na poziomie Floor Price lub poniżej - sprawdź przed zatwierdzeniem.`, produkt.id);
        }
        if (tokenyPozostale - 1 <= 5) {
            await dodajPowiadomienieZDeduplikacja(userId, 'niskie_tokeny', `Zostało Ci tylko ${tokenyPozostale - 1} tokenów AI - rozważ zmianę planu.`, null);
        }

        res.json({ success: true, sugerowana_cena: sugerowanaCenaStr, uzasadnienie: wynik.uzasadnienie, zbuforowane: false, tokeny_pozostale: tokenyPozostale - 1 });
    } catch (e) {
        console.error('Błąd generowania sugestii AI:', e.message);
        res.status(500).json({ success: false, error: 'Błąd generowania sugestii AI: ' + e.message });
    }
});

// Endpoint WSADOWY - do 10 produktów w jednym zapytaniu do AI (oszczędność kosztów).
app.post('/api/ai-sugestia-wsadowo', wymagajSesji, limitAI, sprawdzDziennyLimit, async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.slice(0, 10) : [];
    const jezyk = req.body.jezyk || 'pl';
    const userId = req.session.userId;

    if (ids.length === 0) return res.status(400).json({ success: false, error: 'Nie wybrano żadnych produktów.' });

    const placeholders = ids.map(() => '?').join(',');
    let produkty;
    try {
        produkty = await dbAllAsync(`SELECT * FROM globalne_produkty WHERE id IN (${placeholders}) AND user_id = ?`, [...ids, userId]);
    } catch (e) { return res.status(500).json({ success: false, error: 'Błąd bazy danych.' }); }
    if (!produkty.length) return res.status(404).json({ success: false, error: 'Nie znaleziono produktów.' });

    // TRYB REGUŁOWY - darmowy i natychmiastowy, bez tokenów AI.
    let konfiguracja;
    try { konfiguracja = await dbGetAsync(`SELECT tryb_cenowy, wartosc_reguly, ceny_zawieraja_vat, stawka_vat, floor_price_procent FROM konfiguracja WHERE user_id = ?`, [userId]); } catch (e) {}
    const trybCenowy = konfiguracja?.tryb_cenowy || 'AI';

    if (trybCenowy !== 'AI') {
        const wynikiKoncowe = [];
        const pominieto = [];
        for (const produkt of produkty) {
            const wynikReguly = obliczCeneRegulowa(produktZDostosowanaCenaKonkurencji(produkt, konfiguracja), trybCenowy, konfiguracja?.wartosc_reguly, konfiguracja);
            if (!wynikReguly) { pominieto.push(produkt.nazwa); continue; }
            const cenaStr = wynikReguly.sugerowana_cena.toFixed(2);
            await dbRunAsync(
                `UPDATE globalne_produkty SET sugerowana_cena = ?, rekomendacja = ?, ai_sprawdzona_cena_konkurencji = ?, ai_ostatnio_sprawdzono = ? WHERE id = ?`,
                [cenaStr, wynikReguly.uzasadnienie, produkt.cena_konkurencji, new Date().toISOString(), produkt.id]
            );
            wynikiKoncowe.push({ id: produkt.id, sugerowana_cena: cenaStr, uzasadnienie: wynikReguly.uzasadnienie, zbuforowane: false });
            const floorPrice = obliczFloorPrice(produkt, konfiguracja);
            if (wynikReguly.sugerowana_cena <= floorPrice) {
                await dodajPowiadomienie(userId, 'floor_price', `Sugerowana cena (reguła) dla "${produkt.nazwa}" jest na poziomie Floor Price lub poniżej - sprawdź przed zatwierdzeniem.`, produkt.id);
            }
        }
        return res.json({ success: true, wyniki: wynikiKoncowe, tokeny_uzyte: 0, regula: true, pominieto });
    }

    // TRYB AI - od tego miejsca w dół zachowanie identyczne jak dotychczas.
    if (!ANTHROPIC_API_KEY) {
        return res.status(500).json({ success: false, error: 'Brak klucza ANTHROPIC_API_KEY w pliku .env.' });
    }
    let limity;
    try { limity = await dbGetAsync(`SELECT tokeny_ai FROM limity_uzytkownika WHERE user_id = ?`, [userId]); } catch (e) {}
    const tokenyPozostale = limity ? limity.tokeny_ai : DOMYSLNE_TOKENY_AI;

    const doAnalizy = produkty.filter(p => !czyMoznaUzycCache(p));
    const zbuforowane = produkty.filter(p => czyMoznaUzycCache(p));

    if (doAnalizy.length > tokenyPozostale) {
        return res.status(402).json({
            success: false,
            error: `Za mało tokenów AI (masz ${tokenyPozostale}, potrzeba ${doAnalizy.length}). Przejdź na plan Pro, aby kontynuować.`,
            limit_tokenow: true
        });
    }

    const wynikiKoncowe = zbuforowane.map(p => ({
        id: p.id, sugerowana_cena: p.sugerowana_cena, uzasadnienie: p.rekomendacja, zbuforowane: true
    }));

    if (doAnalizy.length === 0) {
        return res.json({ success: true, wyniki: wynikiKoncowe, tokeny_uzyte: 0 });
    }

    try {
        const doAnalizyDostosowane = doAnalizy.map(p => produktZDostosowanaCenaKonkurencji(p, konfiguracja));
        const wynikiAI = await poprosAIOSugestieWsadowo(doAnalizyDostosowane, jezyk);
        const teraz = new Date().toISOString();

        wynikiAI.forEach(w => {
            const produkt = doAnalizy.find(p => p.id === w.id);
            if (!produkt || typeof w.sugerowana_cena !== 'number') return;
            const sugerowanaCenaStr = w.sugerowana_cena.toFixed(2);
            db.run(
                `UPDATE globalne_produkty SET sugerowana_cena = ?, rekomendacja = ?, ai_sprawdzona_cena_konkurencji = ?, ai_ostatnio_sprawdzono = ? WHERE id = ?`,
                [sugerowanaCenaStr, w.uzasadnienie, produkt.cena_konkurencji, teraz, produkt.id]
            );
            wynikiKoncowe.push({ id: produkt.id, sugerowana_cena: sugerowanaCenaStr, uzasadnienie: w.uzasadnienie, zbuforowane: false });

            const floorPrice = obliczFloorPrice(produkt, konfiguracja);
            if (w.sugerowana_cena <= floorPrice) {
                dodajPowiadomienie(userId, 'floor_price', `Sugerowana cena AI dla "${produkt.nazwa}" jest na poziomie Floor Price lub poniżej - sprawdź przed zatwierdzeniem.`, produkt.id);
            }
        });

        db.run(`UPDATE limity_uzytkownika SET tokeny_ai = tokeny_ai - ? WHERE user_id = ?`, [doAnalizy.length, userId]);

        res.json({ success: true, wyniki: wynikiKoncowe, tokeny_uzyte: doAnalizy.length });
    } catch (e) {
        console.error('Błąd generowania sugestii AI (wsadowo):', e.message);
        res.status(500).json({ success: false, error: 'Błąd generowania sugestii AI: ' + e.message });
    }
});

app.post('/api/globalne-produkty/akceptuj/:id', wymagajSesji, async (req, res) => {
    const { id } = req.params;
    const userId = req.session.userId;

    let row;
    try {
        row = await dbGetAsync(`SELECT * FROM globalne_produkty WHERE id = ? AND user_id = ?`, [id, userId]);
    } catch (e) { return res.status(500).json({ error: 'DB Error' }); }
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!row.sugerowana_cena) return res.status(400).json({ success: false, error: 'Brak sugestii AI dla tego produktu - wygeneruj ją najpierw.' });

    try {
        await dbRunAsync(`UPDATE globalne_produkty SET twoja_cena = ? WHERE id = ?`, [row.sugerowana_cena, id]);
    } catch (e) { return res.status(500).json({ error: 'DB Error' }); }

    await dbRunAsync(
        `INSERT INTO historia_zmian_cen (user_id, produkt_id, stara_cena, nowa_cena, zrodlo, data) VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, id, row.twoja_cena, row.sugerowana_cena, 'Akceptacja sugestii AI', new Date().toLocaleString('pl-PL')]
    );

    // Wyślij nową cenę z powrotem do prawdziwego sklepu (jeśli produkt jest połączony z WooCommerce).
    const wynikWyslania = await wyslijCeneJesliPolaczony(userId, row, row.sugerowana_cena);

    res.json({
        success: true,
        nowaCena: row.sugerowana_cena,
        wyslanoDoSklepu: wynikWyslania.wyslano,
        bladWysylki: wynikWyslania.blad || null
    });
});

app.get('/api/historia-cen/:id', wymagajSesji, (req, res) => {
    db.all(`SELECT * FROM historia_zmian_cen WHERE produkt_id = ? AND user_id = ? ORDER BY id DESC`, [req.params.id, req.session.userId], (err, rows) => {
        res.json(rows || []);
    });
});

// ============== ZAMÓWIENIA ==============
app.get('/api/zamowienia', wymagajSesji, (req, res) => {
    db.all(`SELECT * FROM zamowienia WHERE user_id = ? ORDER BY id DESC`, [req.session.userId], (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/zamowienia', wymagajSesji, (req, res) => {
    const { numer, klient, wartosc, waluta, status } = req.body;
    if (!numer || !klient || !wartosc) return res.status(400).json({ success: false, error: 'Podaj numer zamówienia, klienta i wartość.' });
    db.run(
        `INSERT INTO zamowienia (user_id, numer, klient, data, wartosc, waluta, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [req.session.userId, numer, klient, new Date().toLocaleString('pl-PL'), wartosc, waluta || 'PLN', status || 'Nowe'],
        function (err) {
            if (err) return res.status(500).json({ success: false, error: 'Błąd zapisu zamówienia.' });
            res.json({ success: true, id: this.lastID });
        }
    );
});

app.put('/api/zamowienia/:id/status', wymagajSesji, (req, res) => {
    const { status } = req.body;
    if (!status) return res.status(400).json({ success: false, error: 'Brak statusu.' });
    db.run(`UPDATE zamowienia SET status = ? WHERE id = ? AND user_id = ?`, [status, req.params.id, req.session.userId], (err) => {
        if (err) return res.status(500).json({ success: false, error: 'Błąd aktualizacji statusu.' });
        res.json({ success: true });
    });
});

app.delete('/api/zamowienia/:id', wymagajSesji, (req, res) => {
    db.run(`DELETE FROM zamowienia WHERE id = ? AND user_id = ?`, [req.params.id, req.session.userId], (err) => {
        if (err) return res.status(500).json({ success: false, error: 'Błąd usuwania zamówienia.' });
        res.json({ success: true });
    });
});

// ============== MAGAZYN ==============
app.get('/api/magazyn', wymagajSesji, (req, res) => {
    db.all(`SELECT * FROM magazyn WHERE user_id = ? ORDER BY id DESC`, [req.session.userId], (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/magazyn', wymagajSesji, (req, res) => {
    const { nazwa, sku, ilosc, magazyn_nazwa } = req.body;
    if (!nazwa || ilosc === undefined || ilosc === null || ilosc === '') return res.status(400).json({ success: false, error: 'Podaj nazwę produktu i ilość.' });
    db.run(
        `INSERT INTO magazyn (user_id, nazwa, sku, ilosc, magazyn_nazwa) VALUES (?, ?, ?, ?, ?)`,
        [req.session.userId, nazwa, sku || '', parseInt(ilosc, 10), magazyn_nazwa || 'Magazyn główny'],
        function (err) {
            if (err) return res.status(500).json({ success: false, error: 'Błąd zapisu pozycji magazynowej.' });
            res.json({ success: true, id: this.lastID });
        }
    );
});

app.put('/api/magazyn/:id', wymagajSesji, (req, res) => {
    const { ilosc } = req.body;
    if (ilosc === undefined || ilosc === null || ilosc === '') return res.status(400).json({ success: false, error: 'Brak ilości.' });
    db.run(`UPDATE magazyn SET ilosc = ? WHERE id = ? AND user_id = ?`, [parseInt(ilosc, 10), req.params.id, req.session.userId], (err) => {
        if (err) return res.status(500).json({ success: false, error: 'Błąd aktualizacji ilości.' });
        res.json({ success: true });
    });
});

app.delete('/api/magazyn/:id', wymagajSesji, (req, res) => {
    db.run(`DELETE FROM magazyn WHERE id = ? AND user_id = ?`, [req.params.id, req.session.userId], (err) => {
        if (err) return res.status(500).json({ success: false, error: 'Błąd usuwania pozycji.' });
        res.json({ success: true });
    });
});

// ============== AUTOMATYCZNY HARMONOGRAM (prawdziwy cron w tle) ==============
// Co minutę sprawdza, czy dla któregoś użytkownika nadeszła jego ustawiona
// godzina auto-repricingu (z tabeli konfiguracja, daily_auto_sync = 1).
// Jeśli tak - automatycznie generuje sugestie AI (z pełnym wykorzystaniem
// cache/optymalizacji kosztów i limitu tokenów) i OD RAZU zatwierdza ceny,
// zgodnie z tym co obiecuje przełącznik "Codzienna automatyczna aplikacja cen".
// Bierze pod uwagę WYŁĄCZNIE produkty z auto_pricing = 1 (globalny przełącznik
// w panelu konfiguracji + przełącznik przy pojedynczym produkcie) - produkty
// z wyłączonym Auto-pricingiem są pomijane przez harmonogram całkowicie.
let ostatnioObslozonaMinuta = null;

// Aktualizuje wiersz przebiegu harmonogramu - pomocnicza, "fire and forget"
// (błąd zapisu postępu nie może przerwać samego przetwarzania cen).
async function aktualizujPrzebieg(przebiegId, pola) {
    if (!przebiegId) return;
    const klucze = Object.keys(pola);
    const setSql = klucze.map(k => `${k} = ?`).join(', ');
    try {
        await dbRunAsync(`UPDATE przebiegi_harmonogramu SET ${setSql} WHERE id = ?`, [...klucze.map(k => pola[k]), przebiegId]);
    } catch (e) { /* nieblokujące - postęp to tylko informacja dla UI */ }
}

async function obslugaAutomatycznegoUzytkownika(userId, przebiegId) {
    let konfiguracja;
    try {
        konfiguracja = await dbGetAsync(`SELECT tryb_cenowy, wartosc_reguly, ceny_zawieraja_vat, stawka_vat, floor_price_procent FROM konfiguracja WHERE user_id = ?`, [userId]);
    } catch (e) { await aktualizujPrzebieg(przebiegId, { status: 'blad', blad: 'Błąd odczytu konfiguracji.', zakonczono: new Date().toISOString() }); return; }
    const trybCenowy = konfiguracja?.tryb_cenowy || 'AI';

    let produkty;
    try {
        produkty = await dbAllAsync(`SELECT * FROM globalne_produkty WHERE user_id = ? AND auto_pricing = 1`, [userId]);
    } catch (e) { await aktualizujPrzebieg(przebiegId, { status: 'blad', blad: 'Błąd odczytu produktów.', zakonczono: new Date().toISOString() }); return; }

    await aktualizujPrzebieg(przebiegId, { status: 'w_trakcie', rozpoczeto: new Date().toISOString(), produktow_lacznie: produkty.length });

    if (produkty.length === 0) {
        await aktualizujPrzebieg(przebiegId, { status: 'gotowe', zakonczono: new Date().toISOString() });
        return;
    }

    // KROK 1 (wspólny dla obu trybów): odśwież ceny konkurencji z zapisanych
    // linków, zanim policzymy nowe ceny - żeby zarówno AI, jak i reguła,
    // pracowały na najświeższych danych. Kontekst rynku liczymy RAZ dla
    // całego przebiegu (nie w tle, req niedostępne - użyje publicznego IP
    // serwera), żeby Krok B (awaryjny AI-parser w pobierzCeneZeStrony) miał
    // walutę do porównania, nawet dla produktów bez jawnie ustawionej.
    const kontekstRynkuUzytkownika = await detectStoreContext(userId, undefined);
    let odswiezonoCen = 0;
    for (const p of produkty) {
        if (!p.url_konkurencja) continue;
        try {
            const targetCountry = (p.kraj && p.kraj.trim()) ? p.kraj.trim().toLowerCase() : kontekstRynkuUzytkownika.targetCountry;
            const targetCurrency = (p.waluta && p.waluta !== 'AUTO') ? p.waluta.toUpperCase() : kontekstRynkuUzytkownika.targetCurrency;
            const cena = await pobierzCeneZeStrony(p.url_konkurencja, targetCountry, targetCurrency);
            await dbRunAsync(`UPDATE globalne_produkty SET cena_konkurencji = ? WHERE id = ?`, [cena.toFixed(2), p.id]);
            odswiezonoCen++;
        } catch (e) {
            console.log(`⚠️  Harmonogram: nie udało się odświeżyć ceny konkurencji dla produktu ${p.id} (${p.nazwa}): ${e.message}`);
        }
    }
    if (odswiezonoCen > 0) {
        try {
            produkty = await dbAllAsync(`SELECT * FROM globalne_produkty WHERE user_id = ? AND auto_pricing = 1`, [userId]);
        } catch (e) { /* zostajemy przy poprzednich danych, jeśli odczyt się nie uda */ }
    }

    // KROK 1B: dla produktów, które NADAL nie mają znanej ceny konkurencji
    // (brak zapisanego linku albo link nie zadziałał) - spróbuj ZNALEŹĆ ją
    // automatycznie, tym samym mechanizmem co ręczny przycisk "Znajdź
    // automatycznie". W harmonogramie w tle NIE ma kto ręcznie potwierdzić
    // propozycji, więc auto-akceptujemy TYLKO gdy wskaźnik pewności
    // dopasowania jest wystarczająco wysoki - w przeciwnym razie zostawiamy
    // to do ręcznej weryfikacji i tylko informujemy o tym powiadomieniem.
    // Limit liczby prób na przebieg - to kosztuje realne zapytania do API
    // wyszukiwania i tokeny AI, więc nie robimy tego bez ograniczenia.
    const MAX_AUTO_WYSZUKIWAN_HARMONOGRAM = 5;
    // Próg podniesiony do dolnej granicy pasma "Wysoka" (patrz
    // obliczPewnoscDopasowania: >=75 = Wysoka, 45-74 = Średnia, <45 = Niska).
    // W pełni automatycznym przebiegu w tle - bez człowieka do potwierdzenia
    // - lepiej częściej wysłać powiadomienie "sprawdź ręcznie", niż
    // automatycznie zaakceptować dopasowanie o tylko średniej pewności.
    const PROG_PEWNOSCI_AUTO_AKCEPTACJI = 75;
    if (ANTHROPIC_API_KEY) {
        const doWyszukania = produkty.filter(p => !p.cena_konkurencji).slice(0, MAX_AUTO_WYSZUKIWAN_HARMONOGRAM);
        let znalezionoAutomatycznie = 0;
        let wymagaWeryfikacjiRecznej = 0;
        for (const p of doWyszukania) {
            try {
                const limityAktualne = await dbGetAsync(`SELECT tokeny_ai FROM limity_uzytkownika WHERE user_id = ?`, [userId]);
                if (!limityAktualne || limityAktualne.tokeny_ai <= 0) break; // bez tokenów - przerywamy dalsze próby w tym przebiegu

                const wynik = await wyszukajIZweryfikujOferteKonkurencji(p, 'pl', userId, undefined);
                if (!wynik.success) continue;

                if (wynik.propozycja.pewnoscDopasowania.punkty >= PROG_PEWNOSCI_AUTO_AKCEPTACJI) {
                    await dbRunAsync(
                        `UPDATE globalne_produkty SET cena_konkurencji = ?, url_konkurencja = ? WHERE id = ?`,
                        [wynik.propozycja.cena, wynik.propozycja.link || p.url_konkurencja || '', p.id]
                    );
                    znalezionoAutomatycznie++;
                } else {
                    wymagaWeryfikacjiRecznej++;
                }
            } catch (e) {
                console.log(`⚠️  Harmonogram: błąd auto-wyszukiwania konkurencji dla produktu ${p.id} (${p.nazwa}): ${e.message}`);
            }
        }
        if (wymagaWeryfikacjiRecznej > 0) {
            await dodajPowiadomienieZDeduplikacja(userId, 'niska_pewnosc_harmonogram', `Harmonogram: znaleziono ${wymagaWeryfikacjiRecznej} ${wymagaWeryfikacjiRecznej === 1 ? 'możliwą ofertę' : 'możliwych ofert'} konkurencji, ale pewność dopasowania była zbyt niska do automatycznego zaakceptowania - sprawdź ręcznie w zakładce Repricer.`, null);
        }
        if (znalezionoAutomatycznie > 0) {
            try {
                produkty = await dbAllAsync(`SELECT * FROM globalne_produkty WHERE user_id = ? AND auto_pricing = 1`, [userId]);
            } catch (e) { /* zostajemy przy poprzednich danych */ }
        }
    }

    const terazTekst = new Date().toLocaleString('pl-PL');

    // ============== TRYB REGUŁOWY - darmowy, bez AI, bez tokenów ==============
    if (trybCenowy !== 'AI') {
        let wyslanoDoSklepuReg = 0;
        let wymagaUwagiReg = 0;
        let policzonoReg = 0;
        for (const p of produkty) {
            const wynikReguly = obliczCeneRegulowa(produktZDostosowanaCenaKonkurencji(p, konfiguracja), trybCenowy, konfiguracja?.wartosc_reguly, konfiguracja);
            if (wynikReguly) {
                const cenaStr = wynikReguly.sugerowana_cena.toFixed(2);
                // Zawsze zapisujemy SUGESTIĘ (do wglądu w panelu), ale jeśli
                // wyliczona cena jest identyczna z obecną - NIE dotykamy
                // twoja_cena, NIE logujemy do historii i NIE wysyłamy nic do
                // sklepu. Bez tego harmonogram codziennie generowałby "zmianę
                // z 2500 zł na 2500 zł", zaśmiecając historię i niepotrzebnie
                // odpytując WooCommerce.
                const cenaSieZmienia = cenaStr !== parseFloat(p.twoja_cena).toFixed(2);
                if (!cenaSieZmienia) {
                    await dbRunAsync(
                        `UPDATE globalne_produkty SET sugerowana_cena = ?, rekomendacja = ?, ai_sprawdzona_cena_konkurencji = ?, ai_ostatnio_sprawdzono = ? WHERE id = ?`,
                        [cenaStr, wynikReguly.uzasadnienie, p.cena_konkurencji, new Date().toISOString(), p.id]
                    );
                } else {
                    await dbRunAsync(
                        `UPDATE globalne_produkty SET sugerowana_cena = ?, rekomendacja = ?, ai_sprawdzona_cena_konkurencji = ?, ai_ostatnio_sprawdzono = ?, twoja_cena = ? WHERE id = ?`,
                        [cenaStr, wynikReguly.uzasadnienie, p.cena_konkurencji, new Date().toISOString(), cenaStr, p.id]
                    );
                    await dbRunAsync(
                        `INSERT INTO historia_zmian_cen (user_id, produkt_id, stara_cena, nowa_cena, zrodlo, data) VALUES (?, ?, ?, ?, ?, ?)`,
                        [userId, p.id, p.twoja_cena, cenaStr, 'Harmonogram automatyczny (reguła)', terazTekst]
                    );
                    const wynikWyslania = await wyslijCeneJesliPolaczony(userId, p, cenaStr);
                    if (wynikWyslania.wyslano) wyslanoDoSklepuReg++;
                }
                if (wynikReguly.sugerowana_cena <= obliczFloorPrice(p, konfiguracja)) wymagaUwagiReg++;
                policzonoReg++;
            }
            await aktualizujPrzebieg(przebiegId, { produktow_przetworzonych: policzonoReg });
        }
        if (policzonoReg > 0 || odswiezonoCen > 0) {
            console.log(`✅ Harmonogram (reguła): użytkownik ${userId} - odświeżono ${odswiezonoCen} cen konkurencji, przeliczono ${policzonoReg} produktów, wysłano do sklepu: ${wyslanoDoSklepuReg}.`);
            if (wymagaUwagiReg > 0) {
                await dodajPowiadomienieZDeduplikacja(userId, 'harmonogram', `Harmonogram automatyczny (reguła): ${wymagaUwagiReg} ${wymagaUwagiReg === 1 ? 'produkt wymaga' : 'produktów wymaga'} uwagi (nowa cena na poziomie Floor Price lub poniżej).`, null);
            }
        }
        await aktualizujPrzebieg(przebiegId, { status: 'gotowe', zakonczono: new Date().toISOString() });
        return;
    }

    // ============== TRYB AI - jak dotychczas ==============
    if (!ANTHROPIC_API_KEY) {
        await aktualizujPrzebieg(przebiegId, { status: 'gotowe', zakonczono: new Date().toISOString() });
        return;
    }

    let limity;
    try {
        limity = await dbGetAsync(`SELECT tokeny_ai FROM limity_uzytkownika WHERE user_id = ?`, [userId]);
    } catch (e) { await aktualizujPrzebieg(przebiegId, { status: 'blad', blad: 'Błąd odczytu tokenów.', zakonczono: new Date().toISOString() }); return; }

    const tokeny = limity ? limity.tokeny_ai : 0;
    if (tokeny <= 0) {
        console.log(`⏭️  Harmonogram: pomijam użytkownika ${userId} - brak tokenów AI.`);
        await aktualizujPrzebieg(przebiegId, { status: 'gotowe', zakonczono: new Date().toISOString() });
        return;
    }

    // KROK 2: cache + sugestie AI (jak dotychczas) - teraz już na świeżych cenach.
    const zbuforowane = produkty.filter(p => czyMoznaUzycCache(p) && p.sugerowana_cena);
    const doAnalizy = produkty.filter(p => !czyMoznaUzycCache(p)).slice(0, tokeny);
    const terazIso = new Date().toISOString();

    let wyslanoDoSklepu = 0;
    let wymagaUwagi = 0; // liczba produktów, których nowa cena wylądowała na/poniżej Floor Price
    let przetworzonoLacznie = 0;

    for (const p of zbuforowane) {
        // Tak samo jak w trybie regułowym: pomijamy zapis historii/wysyłkę do
        // sklepu, jeśli cena z pamięci jest identyczna z obecną - nic
        // faktycznie się nie zmienia, więc nie ma czego logować/wysyłać.
        if (String(p.sugerowana_cena) !== parseFloat(p.twoja_cena).toFixed(2)) {
            await dbRunAsync(`UPDATE globalne_produkty SET twoja_cena = ? WHERE id = ?`, [p.sugerowana_cena, p.id]);
            await dbRunAsync(
                `INSERT INTO historia_zmian_cen (user_id, produkt_id, stara_cena, nowa_cena, zrodlo, data) VALUES (?, ?, ?, ?, ?, ?)`,
                [userId, p.id, p.twoja_cena, p.sugerowana_cena, 'Harmonogram automatyczny (z pamięci)', terazTekst]
            );
            const wynikWyslania = await wyslijCeneJesliPolaczony(userId, p, p.sugerowana_cena);
            if (wynikWyslania.wyslano) wyslanoDoSklepu++;
        }
        if (parseFloat(p.sugerowana_cena) <= obliczFloorPrice(p, konfiguracja)) wymagaUwagi++;
        przetworzonoLacznie++;
        await aktualizujPrzebieg(przebiegId, { produktow_przetworzonych: przetworzonoLacznie });
    }

    if (doAnalizy.length === 0) {
        if (zbuforowane.length > 0 || odswiezonoCen > 0) {
            console.log(`✅ Harmonogram: użytkownik ${userId} - odświeżono ${odswiezonoCen} cen konkurencji, zastosowano ${zbuforowane.length} cen z pamięci (bez kosztu AI), wysłano do sklepu: ${wyslanoDoSklepu}.`);
            if (wymagaUwagi > 0) {
                await dodajPowiadomienieZDeduplikacja(userId, 'harmonogram', `Harmonogram automatyczny: ${wymagaUwagi} ${wymagaUwagi === 1 ? 'produkt wymaga' : 'produktów wymaga'} uwagi (nowa cena na poziomie Floor Price lub poniżej).`, null);
            }
        }
        await aktualizujPrzebieg(przebiegId, { status: 'gotowe', zakonczono: new Date().toISOString() });
        return;
    }

    try {
        const doAnalizyDostosowane = doAnalizy.map(p => produktZDostosowanaCenaKonkurencji(p, konfiguracja));
        const wynikiAI = await poprosAIOSugestieWsadowo(doAnalizyDostosowane, 'pl');
        let zuzytychTokenow = 0;

        for (const w of wynikiAI) {
            const produkt = doAnalizy.find(p => p.id === w.id);
            if (!produkt || typeof w.sugerowana_cena !== 'number') continue;
            const sugerowanaCenaStr = w.sugerowana_cena.toFixed(2);
            const cenaSieZmienia = sugerowanaCenaStr !== parseFloat(produkt.twoja_cena).toFixed(2);

            if (!cenaSieZmienia) {
                await dbRunAsync(
                    `UPDATE globalne_produkty SET sugerowana_cena = ?, rekomendacja = ?, ai_sprawdzona_cena_konkurencji = ?, ai_ostatnio_sprawdzono = ? WHERE id = ?`,
                    [sugerowanaCenaStr, w.uzasadnienie, produkt.cena_konkurencji, terazIso, produkt.id]
                );
            } else {
                await dbRunAsync(
                    `UPDATE globalne_produkty SET sugerowana_cena = ?, rekomendacja = ?, ai_sprawdzona_cena_konkurencji = ?, ai_ostatnio_sprawdzono = ?, twoja_cena = ? WHERE id = ?`,
                    [sugerowanaCenaStr, w.uzasadnienie, produkt.cena_konkurencji, terazIso, sugerowanaCenaStr, produkt.id]
                );
                await dbRunAsync(
                    `INSERT INTO historia_zmian_cen (user_id, produkt_id, stara_cena, nowa_cena, zrodlo, data) VALUES (?, ?, ?, ?, ?, ?)`,
                    [userId, produkt.id, produkt.twoja_cena, sugerowanaCenaStr, 'Harmonogram automatyczny (AI)', terazTekst]
                );
                const wynikWyslania = await wyslijCeneJesliPolaczony(userId, produkt, sugerowanaCenaStr);
                if (wynikWyslania.wyslano) wyslanoDoSklepu++;
            }
            if (w.sugerowana_cena <= obliczFloorPrice(produkt, konfiguracja)) wymagaUwagi++;
            zuzytychTokenow++;
            przetworzonoLacznie++;
            await aktualizujPrzebieg(przebiegId, { produktow_przetworzonych: przetworzonoLacznie });
        }

        if (zuzytychTokenow > 0) {
            await dbRunAsync(`UPDATE limity_uzytkownika SET tokeny_ai = tokeny_ai - ? WHERE user_id = ?`, [zuzytychTokenow, userId]);
        }
        if (wymagaUwagi > 0) {
            await dodajPowiadomienieZDeduplikacja(userId, 'harmonogram', `Harmonogram automatyczny: ${wymagaUwagi} ${wymagaUwagi === 1 ? 'produkt wymaga' : 'produktów wymaga'} uwagi (nowa cena na poziomie Floor Price lub poniżej).`, null);
        }
        console.log(`✅ Harmonogram: użytkownik ${userId} - odświeżono ${odswiezonoCen} cen konkurencji, przeanalizowano ${zuzytychTokenow} produktów AI, ${zbuforowane.length} z pamięci, wysłano do sklepu: ${wyslanoDoSklepu}.`);
        await aktualizujPrzebieg(przebiegId, { status: 'gotowe', zakonczono: new Date().toISOString() });
    } catch (e) {
        console.error(`❌ Harmonogram: błąd dla użytkownika ${userId}:`, e.message);
        await aktualizujPrzebieg(przebiegId, { status: 'blad', blad: e.message.slice(0, 500), zakonczono: new Date().toISOString() });
    }
}

// KOLEJKA PRZEBIEGÓW HARMONOGRAMU - to jest sedno bezpiecznego działania
// wielu klientów (multi-tenant) naraz. Bez tego, gdyby wielu klientów miało
// ten sam czas auto-repricingu, wszyscy odpalaliby się jednocześnie, bez
// żadnego limitu - realnie zabijając limity zewnętrznych API (Serper,
// SerpApi, Anthropic) i przeciążając serwer. Teraz: sprawdzHarmonogramy()
// tylko KOLEJKUJE przebiegi (jeden wiersz w bazie na klienta), a osobny
// "worker" (przetwarzajKolejkeHarmonogramow) pobiera z kolejki najstarsze
// oczekujące przebiegi, ale nigdy więcej niż MAX_ROWNOLEGLYCH_PRZEBIEGOW
// naraz - reszta grzecznie czeka w kolejce, aż zwolni się miejsce.
const MAX_ROWNOLEGLYCH_PRZEBIEGOW = 3;
let liczbaAktywnychPrzebiegow = 0;

function sprawdzHarmonogramy() {
    const teraz = new Date();
    const aktualnaMinuta = String(teraz.getHours()).padStart(2, '0') + ':' + String(teraz.getMinutes()).padStart(2, '0');
    if (aktualnaMinuta === ostatnioObslozonaMinuta) return;

    db.all(`SELECT user_id FROM konfiguracja WHERE daily_auto_sync = 1 AND auto_reprice_time = ?`, [aktualnaMinuta], async (err, wiersze) => {
        if (err || !wiersze || wiersze.length === 0) return;
        ostatnioObslozonaMinuta = aktualnaMinuta;
        console.log(`⏰ Harmonogram: godzina ${aktualnaMinuta} - kolejkuję ${wiersze.length} użytkownika/ów.`);

        for (const w of wiersze) {
            // Nie kolejkuj drugi raz, jeśli ten użytkownik ma już przebieg
            // oczekujący albo w trakcie (np. poprzedni jeszcze się nie
            // skończył, a znowu wybiła ta sama minuta następnego dnia -
            // w praktyce rzadkie, ale zabezpieczenie na wszelki wypadek).
            try {
                const istniejacy = await dbGetAsync(
                    `SELECT id FROM przebiegi_harmonogramu WHERE user_id = ? AND status IN ('oczekuje', 'w_trakcie') LIMIT 1`,
                    [w.user_id]
                );
                if (istniejacy) continue;
                await dbRunAsync(
                    `INSERT INTO przebiegi_harmonogramu (user_id, status, utworzono) VALUES (?, 'oczekuje', ?)`,
                    [w.user_id, new Date().toISOString()]
                );
            } catch (e) { console.error(`Błąd kolejkowania przebiegu dla ${w.user_id}:`, e.message); }
        }
    });
}

// Worker - odpalany co kilka sekund, dobiera oczekujące przebiegi TYLKO do
// wolnego limitu współbieżności. To działa niezależnie od tego, ilu
// klientów ma ten sam czas repricingu - system sam rozkłada obciążenie w
// czasie, zamiast próbować zrobić wszystko naraz.
async function przetwarzajKolejkeHarmonogramow() {
    if (liczbaAktywnychPrzebiegow >= MAX_ROWNOLEGLYCH_PRZEBIEGOW) return;

    const wolneMiejsca = MAX_ROWNOLEGLYCH_PRZEBIEGOW - liczbaAktywnychPrzebiegow;
    let oczekujace;
    try {
        oczekujace = await dbAllAsync(
            `SELECT id, user_id FROM przebiegi_harmonogramu WHERE status = 'oczekuje' ORDER BY id ASC LIMIT ?`,
            [wolneMiejsca]
        );
    } catch (e) { return; }

    for (const przebieg of oczekujace) {
        // Oznaczamy przebieg jako "w_trakcie" ATOMOWO, TUTAJ, zanim jeszcze
        // wystartuje jakiekolwiek przetwarzanie - warunek `AND status =
        // 'oczekuje'` w WHERE gwarantuje, że jeśli z jakiegoś powodu ten sam
        // wiersz zostałby wybrany dwukrotnie (np. kolejne tiki interwału),
        // tylko JEDNO z tych wywołań faktycznie "zdobędzie" ten przebieg
        // (this.changes === 1) - drugie nic nie zmieni i zostanie pominięte.
        // Wcześniej to oznaczenie działo się dopiero WEWNĄTRZ
        // obslugaAutomatycznegoUzytkownika, po dwóch wcześniejszych
        // zapytaniach do bazy - zostawiało to (bardzo małe, ale realne) okno
        // na podwójne podjęcie tego samego przebiegu.
        let wynikZdobycia;
        try {
            wynikZdobycia = await dbRunAsync(
                `UPDATE przebiegi_harmonogramu SET status = 'w_trakcie', rozpoczeto = ? WHERE id = ? AND status = 'oczekuje'`,
                [new Date().toISOString(), przebieg.id]
            );
        } catch (e) { continue; }
        if (!wynikZdobycia || wynikZdobycia.changes !== 1) continue; // ktoś/coś innego już to zdobyło - pomijamy

        liczbaAktywnychPrzebiegow++;
        obslugaAutomatycznegoUzytkownika(przebieg.user_id, przebieg.id)
            .catch(e => console.error(`Błąd przebiegu ${przebieg.id} (użytkownik ${przebieg.user_id}):`, e.message))
            .finally(() => { liczbaAktywnychPrzebiegow--; });
    }
}

setInterval(sprawdzHarmonogramy, 60 * 1000);
setInterval(przetwarzajKolejkeHarmonogramow, 10 * 1000);

// Ostatnia linia obrony - jeśli którykolwiek endpoint rzuci błąd, którego nie
// przechwyciliśmy lokalnie, ten handler zwróci klientowi uprzejmy komunikat
// zamiast pustej, zawieszonej odpowiedzi albo crasha serwera.
app.use((err, req, res, next) => {
    console.error('⚠️  Błąd zapytania:', err);
    if (res.headersSent) return next(err);
    res.status(500).json({ success: false, error: 'Wystąpił nieoczekiwany błąd serwera. Spróbuj ponownie.' });
});

app.listen(PORT, () => {
    console.log(`🌍 Serwer działa na http://localhost:${PORT}`);
    console.log(`🛡️  Limity: ${OGOLNY_LIMIT_ZAPYTAN}/min ogólnie, ${AI_LIMIT_NA_GODZINE}/h AI per IP, ${DZIENNY_LIMIT_AI}/dzień AI łącznie.`);
    console.log(`⏰ Automatyczny harmonogram cenowy: aktywny (sprawdzanie co minutę).`);
    if (!ANTHROPIC_API_KEY) console.log('⚠️  Brak ANTHROPIC_API_KEY w .env - sugestie AI nie będą działać, dopóki go nie dodasz.');
});