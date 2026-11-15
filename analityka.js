// Czyste funkcje (bez bazy i sieci) dla: wykresów trendu, alertów, sugestii
// podwyżki, eksportu Excel/CSV i importu feedu XML. Trzymane osobno, żeby
// dało się je testować bez uruchamiania serwera.

// ---------- Daty ----------
// W bazie daty bywają zapisane jako toLocaleString('pl-PL') ("15.11.2026, 20:56:12")
// albo jako ISO. Zwraca timestamp w ms albo null.
function parsujDate(tekst) {
    if (!tekst) return null;
    const s = String(tekst).trim();
    let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m) {
        const t = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)).getTime();
        return isNaN(t) ? null : t;
    }
    const t = Date.parse(s);
    return isNaN(t) ? null : t;
}

const DOZWOLONE_OKRESY = [7, 30, 90, 365];
function normalizujOkres(dni) {
    const n = parseInt(dni, 10);
    return DOZWOLONE_OKRESY.includes(n) ? n : 30;
}

// ---------- Seria do wykresu trendu ----------
// histKonk: wiersze historia_cen_konkurencji {cena, sklep, data}
// histWlasna: wiersze historia_zmian_cen {stara_cena, nowa_cena, data}
function zbudujSerie({ histKonk = [], histWlasna = [], dni = 30, teraz = Date.now(), twojaCena = null, cenaKonkurencji = null }) {
    const od = teraz - dni * 86400000;
    const wKonk = [];
    for (const w of histKonk) {
        const t = parsujDate(w.data);
        const v = parseFloat(w.cena);
        if (t === null || isNaN(v) || v <= 0) continue;
        wKonk.push({ t, v, sklep: w.sklep || '' });
    }
    wKonk.sort((a, b) => a.t - b.t);

    const wWlasna = [];
    for (const w of histWlasna) {
        const t = parsujDate(w.data);
        const v = parseFloat(w.nowa_cena);
        if (t === null || isNaN(v) || v <= 0) continue;
        wWlasna.push({ t, v });
    }
    wWlasna.sort((a, b) => a.t - b.t);

    // Punkt "kotwica": ostatnia znana wartość sprzed początku okresu, żeby linia
    // nie zaczynała się od pustki, gdy w okresie nie było żadnej zmiany.
    const zOkresu = (arr) => {
        const wew = arr.filter(p => p.t >= od && p.t <= teraz + 60000);
        const przed = arr.filter(p => p.t < od);
        if (przed.length) wew.unshift({ ...przed[przed.length - 1], t: od });
        return wew;
    };
    let konk = zOkresu(wKonk);
    let wlasna = zOkresu(wWlasna);
    if (twojaCena !== null && !isNaN(twojaCena) && twojaCena > 0) wlasna.push({ t: teraz, v: Number(twojaCena) });
    if (cenaKonkurencji !== null && !isNaN(cenaKonkurencji) && cenaKonkurencji > 0 && (!konk.length || konk[konk.length - 1].v !== Number(cenaKonkurencji))) {
        konk.push({ t: teraz, v: Number(cenaKonkurencji), sklep: '' });
    }

    const wszystkie = konk.map(p => p.v);
    const statystyki = wszystkie.length ? {
        min: Math.min(...wszystkie),
        max: Math.max(...wszystkie),
        srednia: wszystkie.reduce((a, b) => a + b, 0) / wszystkie.length,
        zmianaPct: wszystkie[0] > 0 ? ((wszystkie[wszystkie.length - 1] - wszystkie[0]) / wszystkie[0]) * 100 : 0
    } : null;
    return { dni, od, do: teraz, konkurencja: konk, wlasna, statystyki };
}

// ---------- Alerty ----------
// Zwraca listę zdarzeń do zgłoszenia po odświeżeniu ceny konkurenta.
function wykryjAlerty({ nazwa, poprzedniaCena, nowaCena, dostepnoscPoprzednia, dostepnoscNowa, twojaCena, floorPrice, ustawienia = {} }) {
    const out = [];
    const pctSpadek = ustawienia.alert_spadek_pct === undefined || ustawienia.alert_spadek_pct === null ? 5 : Number(ustawienia.alert_spadek_pct);
    const poprz = parseFloat(poprzedniaCena);
    const nowa = parseFloat(nowaCena);
    const twoja = parseFloat(twojaCena);
    const floor = parseFloat(floorPrice);

    if (!isNaN(poprz) && !isNaN(nowa) && poprz > 0 && nowa > 0) {
        const zmianaPct = ((nowa - poprz) / poprz) * 100;
        if (pctSpadek > 0 && zmianaPct <= -pctSpadek) {
            out.push({ typ: 'spadek_ceny', tresc: `Konkurent obniżył cenę "${nazwa}" o ${Math.abs(zmianaPct).toFixed(1)}% (z ${poprz.toFixed(2)} do ${nowa.toFixed(2)}).` });
        } else if (ustawienia.alert_wzrost === 1 && zmianaPct >= pctSpadek && pctSpadek > 0) {
            out.push({ typ: 'wzrost_ceny', tresc: `Konkurent podniósł cenę "${nazwa}" o ${zmianaPct.toFixed(1)}% (z ${poprz.toFixed(2)} do ${nowa.toFixed(2)}) - możesz rozważyć podwyżkę.` });
        }
    }
    if (!isNaN(nowa) && nowa > 0 && !isNaN(floor) && floor > 0 && nowa < floor && (isNaN(poprz) || poprz >= floor)) {
        out.push({ typ: 'ponizej_progu', tresc: `Cena konkurenta dla "${nazwa}" (${nowa.toFixed(2)}) spadła poniżej Twojej ceny minimalnej (${floor.toFixed(2)}) - nie możesz jej dogonić bez straty marży.` });
    }
    if (ustawienia.alert_dostepnosc !== 0) {
        if (dostepnoscNowa === 'niedostepny' && dostepnoscPoprzednia !== 'niedostepny') {
            const sug = (!isNaN(twoja) && !isNaN(nowa)) ? ' Konkurent nie ma towaru - to dobry moment, żeby podnieść swoją cenę.' : '';
            out.push({ typ: 'brak_towaru', tresc: `Konkurent nie ma teraz "${nazwa}" na stanie.${sug}` });
        } else if (dostepnoscNowa === 'dostepny' && dostepnoscPoprzednia === 'niedostepny') {
            out.push({ typ: 'powrot_towaru', tresc: `Konkurent znów ma "${nazwa}" na stanie - rozważ powrót do poprzedniej ceny.` });
        }
    }
    return out;
}

// ---------- Sugestia podwyżki (dynamic pricing) ----------
// Gdy jesteś wyraźnie tańszy od rynku, podpowiada cenę tuż pod konkurentem.
function sugestiaPodwyzki({ twojaCena, cenaKonkurencji, floorPrice = 0, minLukaPct = 3, buforPct = 1, maxPodwyzkaPct = 25 }) {
    const twoja = parseFloat(twojaCena);
    const konk = parseFloat(cenaKonkurencji);
    if (isNaN(twoja) || isNaN(konk) || twoja <= 0 || konk <= 0) return null;
    const lukaPct = ((konk - twoja) / konk) * 100;
    if (lukaPct < minLukaPct) return null;
    let cel = konk * (1 - buforPct / 100);
    const maxCena = twoja * (1 + maxPodwyzkaPct / 100);
    if (cel > maxCena) cel = maxCena;
    const floor = parseFloat(floorPrice);
    if (!isNaN(floor) && cel < floor) cel = floor;
    cel = Math.round(cel * 100) / 100;
    if (cel <= twoja * 1.005) return null;
    return {
        cel,
        podwyzkaPct: Math.round(((cel / twoja) - 1) * 1000) / 10,
        lukaPct: Math.round(lukaPct * 10) / 10,
        dodatkowyZyskNaSztuke: Math.round((cel - twoja) * 100) / 100
    };
}

// ---------- Eksport ----------
function ekranujXml(s) {
    return String(s === null || s === undefined ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        // znaki sterujące niedozwolone w XML 1.0
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

// Excel 2003 XML (SpreadsheetML) - otwiera się w Excelu/LibreOffice/Numbers bez zależności.
function generujXls(naglowki, wiersze, nazwaArkusza = 'PriceAI') {
    const komorka = (v) => {
        if (typeof v === 'number' && isFinite(v)) return `<Cell><Data ss:Type="Number">${v}</Data></Cell>`;
        return `<Cell><Data ss:Type="String">${ekranujXml(v)}</Data></Cell>`;
    };
    const wiersz = (arr, styl) => `<Row>${arr.map(v => {
        const c = komorka(v);
        return styl ? c.replace('<Cell>', `<Cell ss:StyleID="${styl}">`) : c;
    }).join('')}</Row>`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles><Style ss:ID="h"><Font ss:Bold="1"/><Interior ss:Color="#E0E7FF" ss:Pattern="Solid"/></Style></Styles>
<Worksheet ss:Name="${ekranujXml(nazwaArkusza).slice(0, 31)}"><Table>
${wiersz(naglowki, 'h')}
${wiersze.map(r => wiersz(r)).join('\n')}
</Table></Worksheet></Workbook>`;
}

// CSV z BOM i średnikiem - Excel w polskich ustawieniach otwiera go poprawnie.
function generujCsv(naglowki, wiersze, separator = ';') {
    const pole = (v) => {
        let s = String(v === null || v === undefined ? '' : v);
        // ochrona przed wstrzyknięciem formuł w Excelu
        if (/^[=+\-@\t\r]/.test(s) && isNaN(Number(s))) s = "'" + s;
        return /[";\n\r]/.test(s) || s.includes(separator) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return '﻿' + [naglowki, ...wiersze].map(r => r.map(pole).join(separator)).join('\r\n') + '\r\n';
}

// ---------- Import feedu XML (Google Merchant: RSS 2.0 / Atom) ----------
function dekodujEncje(s) {
    return String(s)
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&amp;/g, '&')
        .trim();
}

function tag(blok, nazwa) {
    // dopasowuje <g:price>, <price>, <ns:price> - bez względu na prefiks
    const re = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${nazwa}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${nazwa}>`, 'i');
    const m = blok.match(re);
    return m ? dekodujEncje(m[1]) : '';
}

function parsujFeedXml(xml) {
    const tekst = String(xml || '');
    const bloki = [...tekst.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map(m => m[2]);
    const out = [];
    for (const b of bloki) {
        const nazwa = tag(b, 'title');
        const cenaSurowa = tag(b, 'sale_price') || tag(b, 'price');
        const m = cenaSurowa.match(/([0-9][0-9\s.,]*)\s*([A-Za-z]{3})?/);
        let cena = '';
        let waluta = '';
        if (m) {
            let liczba = m[1].replace(/\s/g, '');
            // "1.299,99" -> 1299.99 ; "1,299.99" -> 1299.99 ; "12,50" -> 12.50
            if (liczba.includes(',') && liczba.includes('.')) {
                liczba = liczba.lastIndexOf(',') > liczba.lastIndexOf('.') ? liczba.replace(/\./g, '').replace(',', '.') : liczba.replace(/,/g, '');
            } else if (liczba.includes(',')) {
                liczba = liczba.replace(',', '.');
            }
            cena = liczba;
            waluta = (m[2] || '').toUpperCase();
        }
        let link = tag(b, 'link');
        if (!link) {
            const lm = b.match(/<link[^>]+href=["']([^"']+)["']/i);
            if (lm) link = dekodujEncje(lm[1]);
        }
        out.push({
            nazwa,
            twoja_cena: cena,
            waluta,
            ean: tag(b, 'gtin') || tag(b, 'ean') || '',
            sku: tag(b, 'mpn') || tag(b, 'id') || '',
            marka: tag(b, 'brand'),
            url_produktu: link,
            dostepnosc: tag(b, 'availability')
        });
    }
    return out;
}

// ---------- Klucz API ----------
function haszKluczaApi(klucz, crypto) {
    return crypto.createHash('sha256').update(String(klucz)).digest('hex');
}

// Adres webhooka: tylko https i tylko publiczne hosty (ochrona przed SSRF).
function czyAdresWebhookaDozwolony(url) {
    let u;
    try { u = new URL(String(url)); } catch (e) { return false; }
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.') && !h.includes(':')) return false;
    if (/^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    if (h.startsWith('[') || h.includes(':')) return false; // surowe adresy IPv6 odrzucamy
    return true;
}

module.exports = {
    parsujDate, normalizujOkres, zbudujSerie, wykryjAlerty, sugestiaPodwyzki,
    generujXls, generujCsv, parsujFeedXml, haszKluczaApi, czyAdresWebhookaDozwolony, ekranujXml
};
