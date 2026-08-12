let globalnyKatalog = [];
let globalnyProcentFloorPrice = 75; // domyślny procent Floor Price z konfiguracji użytkownika - wczytywany w wczytajKonfiguracje()
let aktualnyFiltr = 'wszystkie';
let chartInstance = null;
let aktualneSortowanie = { pole: null, kierunek: 1 };
let aktualnaStrona = 1;
const PRODUKTOW_NA_STRONE = 8;

const getSymbol = (waluta) => ({
    USD: '$', EUR: '€', GBP: '£', CHF: 'CHF', PLN: 'zł',
    JPY: '¥', CAD: 'C$', AUD: 'A$', SEK: 'kr', NOK: 'kr',
    DKK: 'kr', CZK: 'Kč', CNY: '¥', INR: '₹', BRL: 'R$', MXN: 'Mex$'
}[waluta] || 'zł');

const apiFetch = async (url, options = {}) => {
    try {
        const res = await fetch(`/api${url}`, { credentials: 'include', ...options });
        const dane = await res.json().catch(() => null);
        if (!res.ok) {
            if (res.status === 401) { window.location.href = 'landing.html'; return null; }
            return dane || { success: false, error: `Błąd serwera (${res.status}).` };
        }
        return dane;
    } catch (err) {
        console.error(`Błąd API (${url}):`, err);
        return null;
    }
};

document.addEventListener('DOMContentLoaded', () => {
    sprawdzSesje();
});

async function sprawdzSesje() {
    try {
        const res = await fetch('/api/me', { credentials: 'include' });
        const dane = await res.json();

        if (!dane.zalogowany) {
            window.location.href = 'landing.html';
            return;
        }

        window.tokenyAI = dane.tokeny_ai;
        window.tokenyAILimit = dane.tokeny_ai_limit;
        window.limitProduktow = dane.limit_produktow;
        window.planUzytkownika = dane.plan;

        const bar = document.getElementById('userBar');
        const text = document.getElementById('userBarText');
        const registerLink = document.getElementById('userBarRegisterLink');
        const tokenyEl = document.getElementById('userBarTokeny');
        const planEl = document.getElementById('userBarPlan');
        const btnPro = document.getElementById('btnAktywujPro');
        if (bar) bar.style.display = 'flex';
        if (dane.demo) {
            if (text) text.innerText = t('demo_banner');
            if (registerLink) registerLink.style.display = 'inline';
        } else {
            if (text) text.innerText = `${t('logged_in_as')} ${dane.email}`;
            if (registerLink) registerLink.style.display = 'none';
        }
        if (tokenyEl) {
            tokenyEl.innerText = `🎟️ ${t('ai_tokens_label')}: ${dane.tokeny_ai}/${dane.tokeny_ai_limit}`;
            tokenyEl.style.color = dane.tokeny_ai <= 5 ? '#f87171' : '#a5b4fc';
        }
        if (planEl) {
            planEl.innerText = dane.plan;
            planEl.style.background = dane.plan === 'PRO' ? '#059669' : (dane.plan === 'DEMO' ? '#475569' : '#334155');
            planEl.style.color = '#fff';
        }
        if (btnPro) btnPro.style.display = !dane.demo ? 'inline-block' : 'none';
        otworzOnboardingJesliPotrzebny(dane);

        pobierzDane();
        wczytajKonfiguracje();
        pobierzPowiadomienia();
        if (!window._pollingPowiadomien) {
            window._pollingPowiadomien = setInterval(pobierzPowiadomienia, 60 * 1000);
        }
    } catch (e) {
        console.error('Błąd sprawdzania sesji:', e);
        window.location.href = 'landing.html';
    }
}

// ============== POWIADOMIENIA ==============
let panelPowiadomienOtwarty = false;

async function pobierzPowiadomienia() {
    const dane = await apiFetch('/powiadomienia');
    if (!Array.isArray(dane)) return;

    const licznik = document.getElementById('licznikPowiadomien');
    const nieprzeczytane = dane.filter(p => !p.przeczytane).length;
    if (licznik) {
        if (nieprzeczytane > 0) {
            licznik.style.display = 'inline-block';
            licznik.innerText = nieprzeczytane > 9 ? '9+' : String(nieprzeczytane);
        } else {
            licznik.style.display = 'none';
        }
    }

    const lista = document.getElementById('listaPowiadomien');
    if (!lista) return;
    if (dane.length === 0) {
        lista.innerHTML = `<div style="text-align:center; color:#64748b; padding:24px;">Brak powiadomień.</div>`;
        return;
    }

    const ikonaTypu = (typ) => ({ floor_price: '⚠️', harmonogram: '⏰', niskie_tokeny: '🎟️' }[typ] || '🔔');

    lista.innerHTML = dane.map(p => `
        <div style="background:${p.przeczytane ? '#0f172a' : '#1e1b4b'}; border:1px solid ${p.przeczytane ? '#334155' : '#4338ca'}; border-radius:8px; padding:10px 12px;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
                <div style="flex:1;">
                    <span style="font-size:13px;">${ikonaTypu(p.typ)} ${p.tresc}</span>
                    <div style="font-size:11px; color:#64748b; margin-top:4px;">${p.data}</div>
                </div>
                ${!p.przeczytane ? `<button onclick="oznaczPowiadomienieJakoPrzeczytane(${p.id})" style="background:none; padding:0; font-size:11px; color:#818cf8; text-decoration:underline; white-space:nowrap;">OK</button>` : ''}
            </div>
        </div>
    `).join('');
}

function przelaczPowiadomienia() {
    panelPowiadomienOtwarty = !panelPowiadomienOtwarty;
    const panel = document.getElementById('panelPowiadomien');
    if (panel) panel.style.display = panelPowiadomienOtwarty ? 'flex' : 'none';
    if (panelPowiadomienOtwarty) pobierzPowiadomienia();
}

async function oznaczPowiadomienieJakoPrzeczytane(id) {
    await apiFetch(`/powiadomienia/${id}/przeczytane`, { method: 'POST' });
    pobierzPowiadomienia();
}

async function oznaczWszystkiePowiadomieniaJakoPrzeczytane() {
    await apiFetch('/powiadomienia/wszystkie-przeczytane', { method: 'POST' });
    pobierzPowiadomienia();
}

function aktualizujLicznikTokenow(pozostale) {
    window.tokenyAI = pozostale;
    const tokenyEl = document.getElementById('userBarTokeny');
    if (tokenyEl) {
        tokenyEl.innerText = `🎟️ ${t('ai_tokens_label')}: ${pozostale}/${window.tokenyAILimit || pozostale}`;
        tokenyEl.style.color = pozostale <= 5 ? '#f87171' : '#a5b4fc';
    }
}

async function wyloguj() {
    await fetch('/api/logout', { method: 'POST', credentials: 'include' });
    window.location.href = 'landing.html';
}

// ============== WCZYTANIE ZAPISANEJ KONFIGURACJI (naprawa: pola i status
// połączenia znikały po każdym odświeżeniu/zalogowaniu, mimo że konfiguracja
// była zapisana w bazie - endpoint /api/konfiguracja istniał, ale nikt go
// wcześniej nie wywoływał z front-endu). ==============
async function wczytajKonfiguracje() {
    const dane = await apiFetch('/konfiguracja');
    if (!dane) return;

    const setVal = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined && val !== null && val !== '') el.value = val; };
    const platformaSelect = document.getElementById('platformaSklepu');
    if (platformaSelect) platformaSelect.value = dane.platforma || 'woocommerce';
    zmienPlatformeSklepu();

    setVal('storeUrl', dane.store_url);
    setVal('consumerKey', dane.consumer_key);
    setVal('consumerSecret', dane.consumer_secret);
    if (dane.waluta) setVal('currency', dane.waluta);
    if (dane.rynek) setVal('marketScope', dane.rynek);
    if (dane.floor_price_procent !== undefined && dane.floor_price_procent !== null) {
        globalnyProcentFloorPrice = dane.floor_price_procent;
        setVal('floorPriceGlobalny', dane.floor_price_procent);
    }
    if (dane.auto_reprice_time) setVal('autoRepriceTime', dane.auto_reprice_time);

    const dailyToggle = document.getElementById('dailyAutoSyncToggle');
    if (dailyToggle) dailyToggle.checked = !!dane.daily_auto_sync;

    const globalToggle = document.getElementById('globalAutoPricing');
    if (globalToggle) globalToggle.checked = dane.global_auto_pricing !== 0;

    const trybSelect = document.getElementById('trybCenowy');
    if (trybSelect) trybSelect.value = dane.tryb_cenowy || 'AI';
    const wartoscInput = document.getElementById('wartoscReguly');
    if (wartoscInput && dane.wartosc_reguly !== undefined && dane.wartosc_reguly !== null) wartoscInput.value = dane.wartosc_reguly;
    pokazUkryjWartoscReguly();

    const kluczeWymagane = (dane.platforma === 'shopify') ? dane.consumer_secret : (dane.consumer_key && dane.consumer_secret);
    if (dane.store_url && kluczeWymagane) {
        ustawStatusPolaczenia(true);
    }
}

// Dostosowuje widoczność/etykiety pól do wybranej platformy - Shopify używa
// jednego tokenu (trzymanego w polu consumerSecret, patrz komentarz w
// server.js), więc pole Consumer Key jest dla niej zbędne; tryb CSV nie
// wymaga żadnych z tych pól w ogóle.
function zmienPlatformeSklepu() {
    const platforma = document.getElementById('platformaSklepu')?.value || 'woocommerce';
    const grupaUrl = document.getElementById('grupaStoreUrl');
    const grupaKey = document.getElementById('grupaConsumerKey');
    const storeUrlEl = document.getElementById('storeUrl');
    const secretEl = document.getElementById('consumerSecret');
    const secretHelp = document.getElementById('consumerSecretHelp');
    const urlHelp = document.getElementById('storeUrlHelp');

    if (grupaKey) grupaKey.style.display = (platforma === 'woocommerce') ? '' : 'none';
    if (grupaUrl) grupaUrl.style.display = (platforma === 'csv') ? 'none' : '';
    if (secretEl) secretEl.parentElement.style.display = (platforma === 'csv') ? 'none' : '';

    if (platforma === 'shopify') {
        if (storeUrlEl) storeUrlEl.placeholder = 'np. twoj-sklep.myshopify.com';
        if (secretEl) secretEl.placeholder = 'Token dostępu Admin API';
        if (secretHelp) secretHelp.innerText = 'Token wygenerowany w Shopify: Ustawienia > Aplikacje i kanały sprzedaży > Twórz aplikację > API Admin (uprawnienia read_products, write_products).';
        if (urlHelp) urlHelp.innerText = 'Domena Twojego sklepu Shopify (bez https://).';
    } else if (platforma === 'woocommerce') {
        if (storeUrlEl) storeUrlEl.placeholder = 'np. https://twojsklep.pl';
        if (secretEl) secretEl.placeholder = 'Consumer Secret (cs_...)';
        if (secretHelp) secretHelp.innerText = t('woo_secret_help');
        if (urlHelp) urlHelp.innerText = t('store_url_help');
    }
}

// Zapisuje globalny, domyślny procent Floor Price - dotyczy wszystkich
// produktów bez własnego, indywidualnego ustawienia.
async function zapiszFloorPriceGlobalny() {
    const input = document.getElementById('floorPriceGlobalny');
    const procent = parseFloat(input?.value);
    if (isNaN(procent) || procent < 1 || procent > 99) {
        pokazToast('Procent Floor Price musi być liczbą od 1 do 99.', 'error');
        return;
    }
    const data = await apiFetch('/floor-price-globalny', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ procent })
    });
    if (data?.success) {
        globalnyProcentFloorPrice = procent;
        pokazToast(`Domyślny Floor Price ustawiony na ${procent}%.`, 'success');
        renderujTabele(globalnyKatalog);
    } else {
        pokazToast(data?.error || 'Błąd zapisu.', 'error');
    }
}

// Nadpisuje Floor Price dla JEDNEGO, konkretnego produktu - przydatne przy
// wąskomarżowych produktach, gdzie globalny procent byłby zbyt niski
// (mógłby zejść poniżej realnego kosztu zakupu).
async function edytujFloorPriceProduktu(id, aktualnyProcent) {
    const wpisany = prompt(`Ustaw indywidualny procent Floor Price dla tego produktu (1-99).\nZostaw puste, żeby użyć globalnego ustawienia (${globalnyProcentFloorPrice}%).`, aktualnyProcent);
    if (wpisany === null) return; // anulowano

    const procent = wpisany.trim() === '' ? null : parseFloat(wpisany);
    if (procent !== null && (isNaN(procent) || procent < 1 || procent > 99)) {
        pokazToast('Procent Floor Price musi być liczbą od 1 do 99.', 'error');
        return;
    }
    const data = await apiFetch(`/produkty/${id}/floor-price`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ procent })
    });
    if (data?.success) {
        pokazToast(procent === null ? 'Przywrócono globalne ustawienie Floor Price.' : `Floor Price dla tego produktu ustawiony na ${procent}%.`, 'success');
        pobierzDane();
    } else {
        pokazToast(data?.error || 'Błąd zapisu.', 'error');
    }
}

let okresPlanu = 'mc';

function ustawOkresPlanu(okres, btnEl) {
    okresPlanu = okres;
    document.querySelectorAll('#planModal .filter-tab').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    renderujPlany(window.cennik);
}

async function otworzModalPlanow() {
    const modal = document.getElementById('planModal');
    if (modal) modal.style.display = 'flex';

    if (!window.cennik) {
        const dane = await apiFetch('/plany');
        window.cennik = dane;
    }
    renderujPlany(window.cennik);
}

function renderujPlany(cennik) {
    const kontener = document.getElementById('planyLista');
    if (!kontener || !cennik) return;

    const kolejnosc = ['STARTER', 'PRO', 'BUSINESS', 'SCALE', 'ENTERPRISE'];
    kontener.innerHTML = kolejnosc.map(nazwa => {
        const p = cennik[nazwa];
        if (!p) return '';
        const cena = okresPlanu === 'rok' ? p.cena_rok : p.cena_mc;
        const jednostka = okresPlanu === 'rok' ? t('period_year_short') : t('period_month_short');
        const aktywny = window.planUzytkownika === nazwa;
        return `
            <div style="background:#0f172a; border:1px solid ${aktywny ? '#4f46e5' : '#334155'}; border-radius:10px; padding:22px; text-align:center;">
                <h4 style="color:#818cf8; margin:0 0 10px 0;">${nazwa}</h4>
                <div style="font-size:28px; font-weight:700; color:#f8fafc; margin-bottom:4px;">${cena} zł</div>
                <div style="font-size:12px; color:#94a3b8; margin-bottom:18px;">/ ${jednostka}</div>
                <div style="font-size:13px; color:#cbd5e1; margin-bottom:6px;">🎟️ ${p.tokeny} ${t('ai_tokens_label').toLowerCase()}/${t('period_month_short')}</div>
                <div style="font-size:13px; color:#cbd5e1; margin-bottom:18px;">📦 ${p.produkty} ${t('products_label')}</div>
                <button class="${aktywny ? 'btn-cancel' : 'btn-success'}" style="width:100%;" ${aktywny ? 'disabled' : ''} onclick="aktywujPlan('${nazwa}')">
                    ${aktywny ? t('current_plan') : t('choose_plan')}
                </button>
            </div>
        `;
    }).join('');
}

async function aktywujPlan(nazwa) {
    const data = await apiFetch('/plan/aktywuj', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: nazwa })
    });
    if (data?.success) {
        pokazToast(`${t('pro_activated')} (${nazwa})`, 'success');
        document.getElementById('planModal').style.display = 'none';
        sprawdzSesje();
    } else {
        pokazToast(data?.error || t('ai_error'), 'error');
    }
}

// ============== TOASTY ==============
function pokazToast(tresc, typ = 'info', opcje = {}) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${typ}`;

    // Domyślnie zwykły tekst - jak dotychczas. Opcjonalnie (opcje.wyjasnienie)
    // dodajemy klikalny link otwierający krótkie, JEDNORAZOWO klikane
    // wyjaśnienie - żeby nie zmuszać nikogo do potwierdzania tego samego
    // komunikatu za każdym razem, gdy zdarzenie jest rutynowe (np. duży sklep
    // blokujący automatyczny odczyt ceny).
    if (opcje.wyjasnienie) {
        toast.innerHTML = `<div>${tresc}</div><button onclick="${opcje.wyjasnienie}" style="background:none; border:none; padding:0; margin-top:6px; font-size:12px; color:#a5b4fc; text-decoration:underline; cursor:pointer;">Dlaczego?</button>`;
    } else {
        toast.innerText = tresc;
    }

    container.appendChild(toast);
    const czasWidocznosci = opcje.wyjasnienie ? 6000 : 3500; // dłużej widoczny, jeśli ma dodatkowy link do kliknięcia
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, czasWidocznosci);
}

// ============== MODAL POTWIERDZENIA ==============
function potwierdz(tresc, onConfirm) {
    const modal = document.getElementById('confirmModal');
    const textEl = document.getElementById('confirmText');
    const btn = document.getElementById('confirmActionBtn');
    if (!modal || !textEl || !btn) return;

    // Reset do domyślnego wyglądu na start KAŻDEGO wywołania - inaczej zmiany
    // wprowadzone przez specjalne przypadki (np. otworzWyjasnienieOdczytuCeny)
    // "uciekałyby" do kolejnych, zwykłych potwierdzeń przez ten sam,
    // współdzielony modal (cloneNode niżej kopiuje bieżący styl przycisku).
    const tytulEl = document.querySelector('#confirmModal h3');
    if (tytulEl) tytulEl.innerText = t('confirm_title');
    const btnAnulujReset = document.querySelector('#confirmModal .btn-cancel');
    if (btnAnulujReset) btnAnulujReset.style.display = '';
    btn.classList.add('btn-danger');
    btn.style.background = '';
    btn.innerText = t('btn_confirm');

    textEl.innerText = tresc;
    modal.style.display = 'flex';

    const nowyBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(nowyBtn, btn);
    nowyBtn.addEventListener('click', () => {
        zamknijPotwierdzenie();
        onConfirm();
    });
}

function zamknijPotwierdzenie() {
    const modal = document.getElementById('confirmModal');
    if (modal) modal.style.display = 'none';
}

// ============== DODAWANIE PRODUKTU ==============
function otworzModalDodawania() {
    const modal = document.getElementById('addProductModal');
    if (modal) modal.style.display = 'flex';
}

async function dodajProdukt() {
    const nazwa = document.getElementById('newProdNazwa')?.value.trim();
    const ean = document.getElementById('newProdEan')?.value.trim();
    const twoja_cena = document.getElementById('newProdTwojaCena')?.value;
    const cena_konkurencji = document.getElementById('newProdCenaKonkurencji')?.value;
    const url_konkurencja = document.getElementById('newProdUrl')?.value.trim();
    const waluta = document.getElementById('newProdWaluta')?.value;
    const kraj = document.getElementById('newProdKraj')?.value;

    if (!nazwa || !twoja_cena) { pokazToast('Podaj przynajmniej nazwę produktu i Twoją cenę.', 'error'); return; }

    const data = await apiFetch('/produkty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nazwa, ean, twoja_cena, cena_konkurencji, url_konkurencja, waluta, kraj })
    });

    if (data?.success) {
        document.getElementById('addProductModal').style.display = 'none';
        ['newProdNazwa', 'newProdEan', 'newProdTwojaCena', 'newProdCenaKonkurencji', 'newProdUrl', 'newProdKraj'].forEach(id => {
            const el = document.getElementById(id); if (el) el.value = '';
        });
        pokazToast('Produkt dodany. Wygeneruj dla niego sugestię AI.', 'success');
        pobierzDane();
    } else {
        pokazToast(data?.error || 'Błąd podczas dodawania produktu.', 'error');
    }
}

// ============== ASYSTENT POMOCY AI ==============
let historiaAsystenta = [];
let asystentOtwarty = false;

function przelaczAsystenta() {
    asystentOtwarty = !asystentOtwarty;
    const panel = document.getElementById('panelAsystenta');
    if (panel) panel.style.display = asystentOtwarty ? 'flex' : 'none';

    if (asystentOtwarty && historiaAsystenta.length === 0) {
        dodajWiadomoscAsystenta('assistant', t('assistant_greeting'));
    }
}

function dodajWiadomoscAsystenta(rola, tresc) {
    const kontener = document.getElementById('wiadomosciAsystenta');
    if (!kontener) return;
    const bubble = document.createElement('div');
    bubble.style.cssText = rola === 'user'
        ? 'align-self:flex-end; background:#4f46e5; color:#fff; padding:9px 13px; border-radius:12px 12px 2px 12px; max-width:85%;'
        : 'align-self:flex-start; background:#0f172a; color:#e2e8f0; padding:9px 13px; border-radius:12px 12px 12px 2px; max-width:85%; border:1px solid #334155;';
    bubble.innerText = tresc;
    kontener.appendChild(bubble);
    kontener.scrollTop = kontener.scrollHeight;
}

async function wyslijPytanieAsystentowi() {
    const input = document.getElementById('inputAsystenta');
    const pytanie = input?.value.trim();
    if (!pytanie) return;

    dodajWiadomoscAsystenta('user', pytanie);
    historiaAsystenta.push({ rola: 'user', tresc: pytanie });
    if (input) input.value = '';

    const kontener = document.getElementById('wiadomosciAsystenta');
    const wskaznikPisania = document.createElement('div');
    wskaznikPisania.id = 'wskaznikPisaniaAsystenta';
    wskaznikPisania.style.cssText = 'align-self:flex-start; color:#64748b; font-size:12px; padding:4px 13px;';
    wskaznikPisania.innerText = t('assistant_typing');
    kontener.appendChild(wskaznikPisania);
    kontener.scrollTop = kontener.scrollHeight;

    const data = await apiFetch('/asystent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pytanie, historia: historiaAsystenta, jezyk: window.aktualnyJezyk || 'pl' })
    });

    document.getElementById('wskaznikPisaniaAsystenta')?.remove();

    if (data?.success) {
        dodajWiadomoscAsystenta('assistant', data.odpowiedz);
        historiaAsystenta.push({ rola: 'assistant', tresc: data.odpowiedz });
    } else {
        dodajWiadomoscAsystenta('assistant', data?.error || t('ai_error'));
    }
}
let idProduktuDlaLinku = null;

async function zmienKrajProduktu(id, aktualnyKraj) {
    const kody = 'pl, de, fr, es, it, nl, at, be, pt, ie, us, gb, ch, jp, ca, au, se, no, dk, cz, cn, in, br, mx';
    const nowyKraj = prompt(`${t('country_prompt')}\n(${kody})`, aktualnyKraj || '');
    if (nowyKraj === null) return;

    const data = await apiFetch(`/produkty/${id}/kraj`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kraj: nowyKraj.trim().toLowerCase() })
    });

    if (data?.success) {
        pokazToast(t('country_saved'), 'success');
        pobierzDane();
    } else {
        pokazToast(data?.error || t('ai_error'), 'error');
    }
}

function ustawLinkKonkurencji(id) {
    idProduktuDlaLinku = id;
    const input = document.getElementById('linkModalInput');
    if (input) input.value = '';
    const modal = document.getElementById('linkModal');
    if (modal) modal.style.display = 'flex';
}

async function zapiszLinkKonkurencji() {
    const url = document.getElementById('linkModalInput')?.value.trim();
    if (!url || !idProduktuDlaLinku) { pokazToast(t('enter_competitor_url'), 'error'); return; }

    const data = await apiFetch(`/produkty/${idProduktuDlaLinku}/url-konkurencji`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
    });

    if (data?.success) {
        document.getElementById('linkModal').style.display = 'none';
        pokazToast(t('link_saved'), 'success');
        pobierzDane();
    } else {
        pokazToast(data?.error || t('ai_error'), 'error');
    }
}

async function pobierzCeneKonkurencji(id, btnEl) {
    if (btnEl) { btnEl.disabled = true; btnEl.innerText = t('fetching_price'); }

    const data = await apiFetch(`/produkty/${id}/pobierz-cene-konkurencji`, { method: 'POST' });

    if (data?.success) {
        pokazToast(`${t('competitor_price_fetched')}: ${data.cena_konkurencji}`, 'success');
        pobierzDane();
    } else if (data?.error && data.error.includes('odczytać ceny')) {
        // To konkretny, rutynowy typ błędu (strona nie udostępniła danych w
        // rozpoznawalnym formacie, często z powodu zabezpieczeń antybotowych
        // dużych sklepów) - profesjonalny komunikat + opcjonalne wyjaśnienie,
        // zamiast surowego komunikatu technicznego.
        pokazToast('Nie udało się automatycznie odczytać ceny z tej strony. Sprawdź ją ręcznie, klikając w link do oferty.', 'error', { wyjasnienie: 'otworzWyjasnienieOdczytuCeny()' });
        if (btnEl) { btnEl.disabled = false; btnEl.innerText = `🔍 ${t('fetch_price')}`; }
    } else {
        pokazToast(data?.error || t('ai_error'), 'error');
        if (btnEl) { btnEl.disabled = false; btnEl.innerText = `🔍 ${t('fetch_price')}`; }
    }
}

// Krótkie, JEDNORAZOWO wywoływane (na życzenie, przez link "Dlaczego?")
// wyjaśnienie najczęstszej przyczyny nieudanego automatycznego odczytu ceny.
// Celowo NIE pokazujemy tego jako wymuszony modal przy każdym błędzie - to
// zdarzenie jest rutynowe przy większych, dobrze chronionych sklepach, więc
// wymaganie kliknięcia "Rozumiem" za każdym razem szybko by zmęczyło.
function otworzWyjasnienieOdczytuCeny() {
    potwierdz(
        'Niektóre sklepy (zwłaszcza duże sieciówki) stosują zabezpieczenia utrudniające automatyczne odczytywanie danych ze strony przez programy komputerowe. W takiej sytuacji system nie jest w stanie samodzielnie potwierdzić aktualnej ceny - zalecamy sprawdzenie jej ręcznie, otwierając link do oferty. To nie jest błąd Twojej konfiguracji.',
        () => {}
    );
    // To czyste wyjaśnienie, nie decyzja do podjęcia - dostosowujemy wygląd
    // współdzielonego modalu potwierdzenia: jeden neutralny przycisk zamiast
    // czerwonego "Potwierdź" + zbędnego w tym kontekście "Anuluj".
    const btn = document.getElementById('confirmActionBtn');
    if (btn) { btn.innerText = 'Rozumiem'; btn.classList.remove('btn-danger'); btn.style.background = '#4f46e5'; }
    const btnAnuluj = document.querySelector('#confirmModal .btn-cancel');
    if (btnAnuluj) btnAnuluj.style.display = 'none';
    const tytul = document.querySelector('#confirmModal h3');
    if (tytul) tytul.innerText = 'Dlaczego cena nie została odczytana?';
}

async function znajdzKonkurencjeAutomatycznie(id, btnEl) {
    if (btnEl) { btnEl.disabled = true; btnEl.innerText = t('searching'); }

    const data = await apiFetch(`/produkty/${id}/znajdz-konkurencje-automatycznie`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jezyk: window.aktualnyJezyk || 'pl' })
    });

    if (btnEl) { btnEl.disabled = false; btnEl.innerText = `🌐 ${t('find_automatically')}`; }
    if (typeof data?.tokeny_pozostale === 'number') aktualizujLicznikTokenow(data.tokeny_pozostale);

    if (data?.success && data.propozycja) {
        pokazModalPotwierdzeniaKonkurencji(id, data.propozycja);
    } else {
        pokazToast(data?.error || t('no_match_found'), 'error');
    }
}

// Buduje rozwijaną listę WSZYSTKICH ofert, które przeszły filtry i zostały
// pokazane AI do wyboru (nie tylko tej wybranej) - żeby było widać, czy
// istniały inne, np. tańsze, i dlaczego akurat ta jedna została uznana za
// najlepiej dopasowaną. Domyślnie zwinięta (<details>), żeby nie zaśmiecać
// modalu dla kogoś, kto tego nie potrzebuje.
function zbudujListeKandydatow(propozycja) {
    const kandydaci = propozycja.wszyscyKandydaci;
    if (!Array.isArray(kandydaci) || kandydaci.length <= 1) return ''; // nic ciekawego do pokazania, gdy był tylko jeden kandydat

    const wiersze = kandydaci.map(k => `
        <div style="display:flex; justify-content:space-between; gap:10px; padding:6px 0; border-bottom:1px solid #1e293b; ${k.wybrana ? 'background:#1e1b4b;' : ''}">
            <span style="flex:1; ${k.wybrana ? 'color:#a5b4fc; font-weight:600;' : 'color:#94a3b8;'}">${k.wybrana ? '✓ ' : ''}${k.tytul} <span style="color:#64748b;">— ${k.sklep}</span></span>
            <span style="white-space:nowrap; ${k.wybrana ? 'color:#a5b4fc; font-weight:600;' : 'color:#94a3b8;'}">${k.cena}</span>
        </div>
    `).join('');

    return `
        <details style="margin-bottom:12px; font-size:12px;">
            <summary style="cursor:pointer; color:#818cf8; user-select:none;">Zobacz wszystkie znalezione oferty (${kandydaci.length})</summary>
            <div style="margin-top:8px; max-height:180px; overflow-y:auto;">${wiersze}</div>
        </details>
    `;
}

function pokazModalPotwierdzeniaKonkurencji(id, propozycja) {
    const tresc = document.getElementById('potwierdzKonkurencjeTresc');
    if (tresc) {
        // Szczegółowe sygnały nadal tu są (nic nie znika), ale teraz są
        // DRUGORZĘDNE - pierwsze co widać to jeden, scalony wskaźnik pewności
        // (liczony po stronie serwera z tych samych sygnałów), żeby ocena
        // "czy warto zaufać tej propozycji" nie wymagała czytania 3-4 osobnych linijek.
        const szczegoly = [];
        szczegoly.push(
            propozycja.zrodloWyszukiwania === 'EAN'
                ? `<span style="color:#34d399;">✅ Dopasowano po kodzie EAN</span>`
                : `<span style="color:#fbbf24;">⚠️ Dopasowano po nazwie (brak/nietrafione EAN)</span>`
        );
        szczegoly.push(
            propozycja.zweryfikowanoNaStronie
                ? `<span style="color:#34d399;">✅ Cena zweryfikowana na żywo na stronie sklepu${propozycja.zrodloWeryfikacji === 'ai' ? ' (przez AI, dane strukturalne strony nie zawierały ceny)' : ''}</span>`
                : `<span style="color:#fbbf24;">⚠️ Cena z wyników wyszukiwania (niezweryfikowana, może być nieaktualna)</span>`
        );
        if (propozycja.mozliwaRozbieznoscCen) {
            szczegoly.push(`<span style="color:#f87171;">🚨 Cena w danych strony i cena widoczna różnią się - sprawdź ręcznie</span>`);
        }
        if (propozycja.dostepnoscOferty === 'niedostepny') {
            szczegoly.push(`<span style="color:#f87171;">🚫 Produkt może być niedostępny u konkurenta</span>`);
        } else if (propozycja.dostepnoscOferty === 'dostepny') {
            szczegoly.push(`<span style="color:#34d399;">✅ Produkt dostępny u konkurenta</span>`);
        }

        const pewnosc = propozycja.pewnoscDopasowania || { etykieta: 'Nieznana', punkty: 50 };
        const kolorPewnosci = pewnosc.etykieta === 'Wysoka' ? '#34d399' : pewnosc.etykieta === 'Niska' ? '#f87171' : '#fbbf24';

        tresc.innerHTML = `
            <div style="display:flex; align-items:center; gap:10px; background:#0f172a; border:1px solid ${kolorPewnosci}; border-radius:8px; padding:10px 14px; margin-bottom:14px;">
                <div style="font-size:22px;">${pewnosc.etykieta === 'Wysoka' ? '🟢' : pewnosc.etykieta === 'Niska' ? '🔴' : '🟡'}</div>
                <div>
                    <div style="font-weight:700; color:${kolorPewnosci}; font-size:14px;">Pewność dopasowania: ${pewnosc.etykieta} (${pewnosc.punkty}%)</div>
                    <div style="font-size:11px; color:#94a3b8;">Wyliczona na podstawie źródła dopasowania, weryfikacji ceny, dostępności i spójności danych.</div>
                </div>
            </div>
            <div style="margin-bottom:10px;"><strong>${propozycja.tytul}</strong></div>
            <div style="margin-bottom:6px;">💰 <strong style="color:#818cf8;">${propozycja.cena} ${getSymbol(propozycja.waluta)}</strong> — ${propozycja.sklep}</div>
            <div style="margin-bottom:8px; font-size:11px; display:flex; flex-direction:column; gap:3px; color:#cbd5e1;">${szczegoly.join('')}</div>
            <div style="margin-bottom:12px; font-size:13px; color:#94a3b8;">🤖 ${propozycja.uzasadnienie}</div>
            ${zbudujListeKandydatow(propozycja)}
            ${propozycja.link ? `<a href="${propozycja.link}" target="_blank" style="color:#d97706; font-size:13px;">${t('open_link_to_verify')} ↗</a>` : ''}
        `;
    }
    const modal = document.getElementById('potwierdzKonkurencjeModal');
    if (modal) modal.style.display = 'flex';

    const btn = document.getElementById('potwierdzKonkurencjeBtn');
    if (btn) {
        const nowyBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(nowyBtn, btn);
        nowyBtn.addEventListener('click', async () => {
            const wynik = await apiFetch(`/produkty/${id}/potwierdz-konkurencje`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cena: propozycja.cena, link: propozycja.link, sklep: propozycja.sklep })
            });
            document.getElementById('potwierdzKonkurencjeModal').style.display = 'none';
            if (wynik?.success) {
                pokazToast(t('competitor_saved'), 'success');
                pobierzDane();
            } else {
                pokazToast(wynik?.error || t('ai_error'), 'error');
            }
        });
    }
}

async function generujSugestieAI(id, btnEl) {
    if (btnEl) { btnEl.disabled = true; btnEl.innerText = t('analyzing'); }
    const data = await apiFetch(`/ai-sugestia/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jezyk: window.aktualnyJezyk || 'pl' })
    });

    if (data?.success) {
        if (data.zbuforowane) {
            pokazToast(t('ai_cached_reused'), 'info');
        } else {
            pokazToast(t('ai_suggestion_generated'), 'success');
            if (typeof data.tokeny_pozostale === 'number') aktualizujLicznikTokenow(data.tokeny_pozostale);
        }
        pobierzDane();
    } else if (data?.limit_tokenow) {
        pokazToast(data.error, 'error');
        if (btnEl) { btnEl.disabled = false; btnEl.innerText = t('btn_generate_ai'); }
    } else {
        pokazToast(data?.error || t('ai_error'), 'error');
        if (btnEl) { btnEl.disabled = false; btnEl.innerText = t('btn_generate_ai'); }
    }
}

// Zbiorcza analiza AI dla zaznaczonych produktów (maks. 10) - JEDNO zapytanie
// do modelu zamiast osobnego na każdy produkt, co realnie obniża koszt.
async function generujSugestieAIWsadowo() {
    const zaznaczoneId = [...document.querySelectorAll('.prod-checkbox:checked')].map(cb => parseInt(cb.value, 10));
    if (zaznaczoneId.length === 0) { pokazToast(t('select_products_first'), 'error'); return; }
    if (zaznaczoneId.length > 10) { pokazToast(t('max_10_at_once'), 'error'); return; }

    const data = await apiFetch('/ai-sugestia-wsadowo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: zaznaczoneId, jezyk: window.aktualnyJezyk || 'pl' })
    });

    if (data?.success) {
        const nowe = data.wyniki.filter(w => !w.zbuforowane).length;
        const zCache = data.wyniki.filter(w => w.zbuforowane).length;
        pokazToast(`${t('ai_batch_done')}: ${nowe} ${t('ai_batch_new')}, ${zCache} ${t('ai_batch_cached')}.`, 'success');
        if (window.tokenyAI !== undefined) aktualizujLicznikTokenow(window.tokenyAI - data.tokeny_uzyte);
        pobierzDane();
    } else if (data?.limit_tokenow) {
        pokazToast(data.error, 'error');
    } else {
        pokazToast(data?.error || t('ai_error'), 'error');
    }
}

// ============== SZYBKI WYBÓR GODZINY HARMONOGRAMU ==============
function ustawGodzine(godzina, btnEl) {
    const input = document.getElementById('autoRepriceTime');
    if (input) input.value = godzina;
    document.querySelectorAll('.time-preset-btn').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
}

// ============== PRZEŁĄCZANIE ZAKŁADEK ==============
function zmienZakladke(idSekcji, btnEl) {
    document.querySelectorAll('.hub-section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.hub-nav-tab').forEach(t => t.classList.remove('active'));
    document.getElementById(`section-${idSekcji}`).classList.add('active');
    btnEl.classList.add('active');
    if (idSekcji === 'katalog') renderujKatalogZakladka();
    if (idSekcji === 'zamowienia') pobierzZamowienia();
    if (idSekcji === 'magazyn') pobierzMagazyn();
    if (idSekcji === 'synchronizacja') pobierzStatusHarmonogramu();
}

// ============== STATUS HARMONOGRAMU W TLE (kolejka wielu klientów) ==============
async function pobierzStatusHarmonogramu() {
    const dane = await apiFetch('/harmonogram/status');
    const box = document.getElementById('statusHarmonogramuBox');
    if (!box) return;

    if (!dane) { box.style.display = 'none'; return; }
    box.style.display = 'block';

    const etykietaEl = document.getElementById('statusHarmonogramuEtykieta');
    const pasekEl = document.getElementById('statusHarmonogramuPasek');
    const tekstEl = document.getElementById('statusHarmonogramuTekst');

    const mapaStatusow = {
        oczekuje: { tekst: 'W kolejce', kolor: '#475569' },
        w_trakcie: { tekst: 'W trakcie', kolor: '#4f46e5' },
        gotowe: { tekst: 'Zakończono', kolor: '#059669' },
        blad: { tekst: 'Błąd', kolor: '#dc2626' }
    };
    const info = mapaStatusow[dane.status] || mapaStatusow.oczekuje;
    if (etykietaEl) { etykietaEl.innerText = info.tekst; etykietaEl.style.background = info.kolor; etykietaEl.style.color = '#fff'; }

    const lacznie = dane.produktow_lacznie || 0;
    const przetworzono = dane.produktow_przetworzonych || 0;
    const procent = lacznie > 0 ? Math.round((przetworzono / lacznie) * 100) : (dane.status === 'gotowe' ? 100 : 0);
    if (pasekEl) { pasekEl.style.width = `${procent}%`; pasekEl.style.background = info.kolor; }

    if (tekstEl) {
        if (dane.status === 'blad') {
            tekstEl.innerText = `Błąd: ${dane.blad || 'nieznany'}`;
        } else if (lacznie > 0) {
            tekstEl.innerText = `Sprawdzono ${przetworzono} z ${lacznie} produktów.`;
        } else {
            tekstEl.innerText = dane.status === 'oczekuje' ? 'Oczekuje na wolne miejsce w kolejce...' : 'Brak produktów do sprawdzenia w tym przebiegu.';
        }
    }

    // Odpytuj częściej, dopóki przebieg trwa - żeby pasek postępu faktycznie
    // się ruszał, a nie wymagał ręcznego odświeżania strony.
    if (dane.status === 'oczekuje' || dane.status === 'w_trakcie') {
        clearTimeout(window._statusHarmonogramuTimeout);
        window._statusHarmonogramuTimeout = setTimeout(pobierzStatusHarmonogramu, 5000);
    }
}

// ============== STATUS POŁĄCZENIA ==============
function ustawStatusPolaczenia(polaczono) {
    const badge = document.getElementById('crawlerStatusBadge');
    const textEl = document.getElementById('crawlerStatusText');
    if (!badge || !textEl) return;
    if (polaczono) {
        badge.style.background = '#059669';
        textEl.setAttribute('data-i18n', 'crawler_status_connected');
    } else {
        badge.style.background = '#475569';
        textEl.setAttribute('data-i18n', 'crawler_status_disconnected');
    }
    textEl.textContent = t(textEl.getAttribute('data-i18n'));
}

// ============== POBIERANIE DANYCH ==============
function pokazLoadingTabeli() {
    const tbody = document.getElementById('tabela-oferty');
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 40px;"><div class="spinner"></div></td></tr>`;
}

function ustawTrend(elementId, aktualna, poprzednia) {
    const el = document.getElementById(elementId);
    if (!el) return;
    if (poprzednia === undefined || poprzednia === null || isNaN(poprzednia) || parseFloat(poprzednia) === 0) {
        el.innerHTML = '';
        return;
    }
    const zmiana = ((parseFloat(aktualna) - parseFloat(poprzednia)) / parseFloat(poprzednia)) * 100;
    if (Math.abs(zmiana) < 0.05) { el.innerHTML = ''; return; }
    const klasa = zmiana >= 0 ? 'trend-up' : 'trend-down';
    const strzalka = zmiana >= 0 ? '▲' : '▼';
    el.innerHTML = `<span class="${klasa}">${strzalka} ${Math.abs(zmiana).toFixed(1)}%</span>`;
}

async function pobierzDane() {
    pokazLoadingTabeli();

    const [staty, produkty] = await Promise.all([
        apiFetch('/statystyki'),
        apiFetch('/globalne-produkty')
    ]);

    if (staty && staty.length > 0) {
        const m = staty.find(s => s.okres === 'miesiac') || staty[0];
        const w = staty.find(s => s.okres === 'tydzien') || staty[0];
        const walutaWybrana = document.getElementById('currency')?.value;
        const symbol = getSymbol(walutaWybrana && walutaWybrana !== 'AUTO' ? walutaWybrana : m.waluta);

        const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = `${val} ${symbol}`; };
        setVal('val-sales-m', m.sprzedaz);
        setVal('val-profit-m', m.zysk);
        setVal('val-sales-w', w.sprzedaz);
        setVal('val-profit-w', w.zysk);

        // Trend pokazuje się tylko, jeśli backend faktycznie dostarczy dane z poprzedniego okresu
        // (pole poprzedni_sprzedaz / poprzedni_zysk) - bez fikcyjnych wartości.
        ustawTrend('trend-sales-m', m.sprzedaz, m.poprzedni_sprzedaz);
        ustawTrend('trend-profit-m', m.zysk, m.poprzedni_zysk);
        ustawTrend('trend-sales-w', w.sprzedaz, w.poprzedni_sprzedaz);
        ustawTrend('trend-profit-w', w.zysk, w.poprzedni_zysk);
    }

    if (Array.isArray(produkty)) {
        globalnyKatalog = produkty;
        aktualnaStrona = 1;
        renderujTabele(globalnyKatalog);
    } else {
        const tbody = document.getElementById('tabela-oferty');
        if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: #94a3b8; padding: 40px;">${t('empty_products')}</td></tr>`;
        const pag = document.getElementById('paginationBar');
        if (pag) pag.style.display = 'none';
    }
}

function renderujKatalogZakladka() {
    const tbody = document.getElementById('katalog-produktu-tbody');
    if (!tbody) return;

    if (!globalnyKatalog.length) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #94a3b8; padding: 30px;">${t('catalog_empty')}</td></tr>`;
        return;
    }

    // Pokazujemy wyłącznie realne dane produktu - bez zmyślonej, jednakowej
    // dla wszystkich kategorii; status "w sklepie" odzwierciedla to, czy
    // produkt jest faktycznie powiązany z WooCommerce (woo_produkt_id).
    tbody.innerHTML = globalnyKatalog.map(p => `
        <tr>
            <td><code>#${p.id}</code></td>
            <td><strong>${p.nazwa}</strong></td>
            <td>${p.ean || '-'}</td>
            <td><strong>${p.twoja_cena} ${getSymbol(p.waluta)}</strong></td>
            <td>${p.woo_produkt_id ? `<span style="color: #34d399;">${t('catalog_active')}</span>` : `<span style="color: #94a3b8;">Tylko lokalnie</span>`}</td>
        </tr>
    `).join('');
}

// ============== SORTOWANIE ==============
function ustawSortowanie(pole) {
    if (aktualneSortowanie.pole === pole) {
        aktualneSortowanie.kierunek *= -1;
    } else {
        aktualneSortowanie = { pole, kierunek: 1 };
    }
    document.querySelectorAll('.sort-icon').forEach(el => el.innerText = '↕');
    const icon = document.getElementById(`sort-${pole}`);
    if (icon) icon.innerText = aktualneSortowanie.kierunek === 1 ? '↑' : '↓';
    aktualnaStrona = 1;
    filtrujProdukty();
}

function posortuj(lista) {
    if (!aktualneSortowanie.pole) return lista;
    const { pole, kierunek } = aktualneSortowanie;
    return [...lista].sort((a, b) => {
        let va = a[pole], vb = b[pole];
        if (pole !== 'nazwa') { va = parseFloat(va); vb = parseFloat(vb); }
        if (va < vb) return -1 * kierunek;
        if (va > vb) return 1 * kierunek;
        return 0;
    });
}

// ============== PAGINACJA ==============
function zmienStrone(delta) {
    aktualnaStrona += delta;
    filtrujProdukty();
}

function stronicuj(lista) {
    const start = (aktualnaStrona - 1) * PRODUKTOW_NA_STRONE;
    return lista.slice(start, start + PRODUKTOW_NA_STRONE);
}

function aktualizujPaginacje(liczbaWszystkich) {
    const pag = document.getElementById('paginationBar');
    if (!pag) return;
    const liczbaStron = Math.max(1, Math.ceil(liczbaWszystkich / PRODUKTOW_NA_STRONE));
    if (aktualnaStrona > liczbaStron) aktualnaStrona = liczbaStron;

    pag.style.display = liczbaWszystkich > PRODUKTOW_NA_STRONE ? 'flex' : 'none';
    document.getElementById('pageInfo').innerText = `${t('page_label')} ${aktualnaStrona} ${t('of_label')} ${liczbaStron}`;
    document.getElementById('btnPrevPage').disabled = aktualnaStrona <= 1;
    document.getElementById('btnNextPage').disabled = aktualnaStrona >= liczbaStron;
}

// ============== TABELA GŁÓWNA ==============
function renderujTabele(produkty) {
    const tbody = document.getElementById('tabela-oferty');
    if (!tbody) return;

    const posortowane = posortuj(produkty);
    aktualizujPaginacje(posortowane.length);
    const naStronie = stronicuj(posortowane);

    if (posortowane.length === 0) {
        // Rozróżniamy dwa różne "puste" stany: brak JAKICHKOLWIEK produktów
        // na koncie (zaproszenie do dodania/skonfigurowania integracji) od
        // braku wyników dla aktywnego filtra/wyszukiwania.
        const wiadomosc = globalnyKatalog.length === 0 ? t('empty_products') : t('no_matches');
        tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: #94a3b8; padding: 40px;">${wiadomosc}</td></tr>`;
        return;
    }

    tbody.innerHTML = naStronie.map(p => {
        const symbol = getSymbol(p.waluta);
        const procentFloor = (p.floor_price_procent !== null && p.floor_price_procent !== undefined) ? p.floor_price_procent : globalnyProcentFloorPrice;
        const floorPrice = (p.twoja_cena * (procentFloor / 100)).toFixed(2);
        const maSugestie = p.sugerowana_cena !== null && p.sugerowana_cena !== undefined && p.sugerowana_cena !== '';
        const isDanger = maSugestie && parseFloat(p.sugerowana_cena) < parseFloat(floorPrice);

        const sugestiaHtml = maSugestie
            ? `<span style="color: ${isDanger ? '#ef4444' : '#4f46e5'}; font-weight: 700; font-size: 15px;">${p.sugerowana_cena} ${symbol}</span>
               ${isDanger ? '<span class="margin-danger">⚠️ Poniżej Floor Price</span>' : ''}`
            : `<button class="chart-badge-btn" onclick="generujSugestieAI(${p.id}, this)">${t('btn_generate_ai')}</button>`;

        const rekomendacjaHtml = p.rekomendacja
            ? `<div class="strategy-badge" style="white-space: normal; max-width: 260px;"><span class="strategy-icon">🤖</span><span>${p.rekomendacja}</span></div>`
            : `<span style="color: #64748b; font-size: 12px;">${t('no_suggestion')}</span>`;

        return `
            <tr>
                <td><input type="checkbox" class="prod-checkbox" value="${p.id}" onchange="aktualizujPasekMasowy()"></td>
                <td>
                    <strong>${p.nazwa}</strong>
                    <button class="chart-badge-btn" onclick="pokazWykresHistorii(${p.id}, '${p.nazwa}', ${p.twoja_cena}, ${p.cena_konkurencji || 0}, '${symbol}', ${floorPrice})">${t('btn_compare')}</button>
                    <button class="chart-badge-btn" onclick="pokazLogZmian(${p.id}, '${p.nazwa}')">${t('btn_log')}</button>
                </td>
                <td>
                    <code>${p.ean || '-'}</code>
                    <div style="font-size: 11px; color: #64748b; margin-top: 3px;">
                        Floor Price: <strong>${floorPrice} ${symbol}</strong> (${procentFloor}%)
                        <button onclick="edytujFloorPriceProduktu(${p.id}, ${procentFloor})" style="background:none; border:none; color:#818cf8; cursor:pointer; padding:0; margin-left:4px; font-size:11px;" title="Zmień procent Floor Price dla TEGO produktu">✏️</button>
                    </div>
                </td>
                <td><strong>${p.twoja_cena} ${symbol}</strong></td>
                <td>
                    <div style="display:flex; flex-direction:column; gap:4px; align-items:flex-start;">
                        ${p.cena_konkurencji
                            ? `<div><a href="${p.url_konkurencja || '#'}" target="_blank" style="color: #d97706; font-weight: 600; text-decoration: none;">${p.cena_konkurencji} ${symbol} ↗</a>
                               <button class="chart-badge-btn" onclick="pobierzCeneKonkurencji(${p.id}, this)">🔄</button></div>`
                            : p.url_konkurencja
                                ? `<button class="chart-badge-btn" onclick="pobierzCeneKonkurencji(${p.id}, this)">🔍 ${t('fetch_price')}</button>`
                                : `<button class="chart-badge-btn" onclick="ustawLinkKonkurencji(${p.id})">➕ ${t('add_link')}</button>
                                   <button class="chart-badge-btn" onclick="znajdzKonkurencjeAutomatycznie(${p.id}, this)">🌐 ${t('find_automatically')}</button>`
                        }
                        <span onclick="zmienKrajProduktu(${p.id}, '${p.kraj || ''}')" style="font-size:11px; color:#64748b; cursor:pointer; text-decoration:underline dotted;">🌍 ${t('country_label')}: ${p.kraj ? p.kraj.toUpperCase() : t('country_auto')}</span>
                    </div>
                </td>
                <td>${sugestiaHtml}</td>
                <td>${rekomendacjaHtml}</td>
                <td>
                    <div class="action-container" style="flex-wrap: wrap; row-gap: 8px;">
                        <div style="display:flex; flex-direction:column; align-items:center; gap:3px;">
                            <label class="switch" title="${t('switch_auto_pricing_tip')}">
                                <input type="checkbox" ${p.auto_pricing ? 'checked' : ''} onchange="toggleProductAuto(${p.id}, this)">
                                <span class="slider"></span>
                            </label>
                            <span style="font-size:10px; color:#64748b; font-weight:600; white-space:nowrap;">${t('switch_auto_pricing_label')}</span>
                        </div>
                        ${maSugestie ? `<button class="btn-success" title="${t('btn_change_to_tip')}" onclick="akceptujCenu(${p.id})">${t('btn_change_to')} ${p.sugerowana_cena} ${symbol}</button>` : ''}
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

// ============== WYKRES PORÓWNAWCZY ==============
// Lekki, samodzielny plugin Chart.js (bez dodatkowej biblioteki) - dopisuje
// wartość liczbową nad każdym słupkiem, żeby nie trzeba było czytać jej z osi.
const pluginEtykietWartosci = {
    id: 'etykietyWartosci',
    afterDatasetsDraw(chart) {
        const { ctx } = chart;
        chart.data.datasets.forEach((dataset, i) => {
            const meta = chart.getDatasetMeta(i);
            meta.data.forEach((bar, index) => {
                const wartosc = dataset.data[index];
                if (wartosc === null || wartosc === undefined) return;
                ctx.save();
                ctx.fillStyle = '#f8fafc';
                ctx.font = '700 13px Segoe UI, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText(`${wartosc.toFixed(2)} ${dataset.jednostka || ''}`, bar.x, bar.y - 8);
                ctx.restore();
            });
        });
    }
};

// Rysuje poziomą, przerywaną linię na poziomie Floor Price - żeby od razu
// było widać, czy porównywane ceny są bezpiecznie powyżej minimalnej marży.
const pluginLiniiFloorPrice = {
    id: 'liniaFloorPrice',
    afterDatasetsDraw(chart) {
        const floorPrice = chart.config._floorPrice;
        if (!floorPrice || floorPrice <= 0) return;
        const { ctx, scales } = chart;
        const y = scales.y.getPixelForValue(floorPrice);
        if (y < scales.y.top || y > scales.y.bottom) return; // poza widocznym zakresem osi
        ctx.save();
        ctx.strokeStyle = '#f87171';
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(scales.x.left, y);
        ctx.lineTo(scales.x.right, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#f87171';
        ctx.font = '700 11px Segoe UI, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`Floor Price: ${floorPrice.toFixed(2)}`, scales.x.left + 6, y - 6);
        ctx.restore();
    }
};

function pokazWykresHistorii(productId, nazwaProduktu, cenaBazowa, cenaKonkurencjiRef, symbol, floorPrice) {
    const modal = document.getElementById('historyModal');
    const modalTitle = document.getElementById('modalTitle');
    if (!modal) return;

    modalTitle.innerText = `📊 Porównanie cen: ${nazwaProduktu}`;
    modal.style.display = 'flex';

    if (chartInstance) chartInstance.destroy();

    // Krótkie podsumowanie tekstowe nad wykresem - procentowa różnica jest
    // dla oka szybsza do przeczytania niż porównywanie wysokości słupków.
    const podsumowanieEl = document.getElementById('podsumowaniePorownania');
    if (podsumowanieEl) {
        if (cenaKonkurencjiRef > 0) {
            const roznica = ((cenaBazowa - cenaKonkurencjiRef) / cenaKonkurencjiRef) * 100;
            const tekst = roznica > 0.5
                ? `Twoja cena jest o <strong style="color:#f87171;">${roznica.toFixed(1)}% wyższa</strong> niż konkurencja`
                : roznica < -0.5
                    ? `Twoja cena jest o <strong style="color:#34d399;">${Math.abs(roznica).toFixed(1)}% niższa</strong> niż konkurencja`
                    : `Twoja cena jest <strong style="color:#94a3b8;">praktycznie taka sama</strong> jak u konkurencji`;
            podsumowanieEl.innerHTML = tekst;
        } else {
            podsumowanieEl.innerHTML = `<span style="color:#94a3b8;">Brak znanej ceny konkurencji do porównania.</span>`;
        }
    }

    // Pokazujemy wyłącznie realne, aktualne wartości. Historyczne notowania
    // wymagają osobnej tabeli zapisującej codzienne odczyty (do wdrożenia
    // po podłączeniu realnego źródła danych).
    chartInstance = new Chart(document.getElementById('priceHistoryChart').getContext('2d'), {
        type: 'bar',
        data: {
            labels: ['Twoja cena', 'Cena konkurencji'],
            datasets: [{
                data: [parseFloat(cenaBazowa), parseFloat(cenaKonkurencjiRef) || null],
                jednostka: symbol,
                backgroundColor: ['#4f46e5', '#d97706'],
                hoverBackgroundColor: ['#6366f1', '#f59e0b'],
                borderRadius: 8,
                borderSkipped: false,
                barThickness: 90
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: { top: 24 } },
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color: '#cbd5e1', font: { weight: '600' } }, grid: { display: false } },
                y: { ticks: { color: '#94a3b8' }, grid: { color: '#1e293b' }, beginAtZero: true }
            }
        },
        plugins: [pluginEtykietWartosci, pluginLiniiFloorPrice]
    });
    chartInstance.config._floorPrice = parseFloat(floorPrice) || 0;
    chartInstance.update();
}

// ============== LOG ZMIAN CENY ==============
async function pokazLogZmian(productId, nazwaProduktu) {
    const modal = document.getElementById('logModal');
    const title = document.getElementById('logModalTitle');
    const tbody = document.getElementById('logModalTbody');
    if (!modal) return;

    title.innerText = `🧾 Historia zmian ceny: ${nazwaProduktu}`;
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding: 20px;"><div class="spinner"></div></td></tr>`;
    modal.style.display = 'flex';

    const dane = await apiFetch(`/historia-cen/${productId}`);
    if (!dane || dane.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:#94a3b8; padding: 20px;">Brak zapisanych zmian dla tego produktu.</td></tr>`;
        return;
    }

    tbody.innerHTML = dane.map(w => `
        <tr>
            <td>${w.data}</td>
            <td>${w.stara_cena}</td>
            <td>${w.nowa_cena}</td>
            <td>${w.zrodlo}</td>
        </tr>
    `).join('');
}

const closeHistoryModal = () => { const m = document.getElementById('historyModal'); if (m) m.style.display = 'none'; };
window.onclick = (e) => {
    if (e.target === document.getElementById('historyModal')) closeHistoryModal();
    if (e.target === document.getElementById('logModal')) document.getElementById('logModal').style.display = 'none';
    if (e.target === document.getElementById('confirmModal')) zamknijPotwierdzenie();
    if (e.target === document.getElementById('podgladZatwierdzeniaModal')) document.getElementById('podgladZatwierdzeniaModal').style.display = 'none';
};

// ============== FILTROWANIE ==============
function zmienFiltr(typ, btn) {
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    aktualnyFiltr = typ;
    aktualnaStrona = 1;
    filtrujProdukty();
}

function filtrujProdukty() {
    const query = document.getElementById('searchInput')?.value.toLowerCase() || '';
    renderujTabele(globalnyKatalog.filter(p => {
        if (!p.nazwa.toLowerCase().includes(query) && !(p.ean || '').toLowerCase().includes(query)) return false;
        if (aktualnyFiltr === 'uwaga') {
            const procentFloor = (p.floor_price_procent !== null && p.floor_price_procent !== undefined) ? p.floor_price_procent : globalnyProcentFloorPrice;
            return p.sugerowana_cena && parseFloat(p.sugerowana_cena) < (p.twoja_cena * (procentFloor / 100));
        }
        if (aktualnyFiltr === 'brak-sugestii') return !p.sugerowana_cena;
        return true;
    }));
}

// ============== ZAZNACZANIE / AKCJE MASOWE ==============
function zaznaczWszystkie(master) {
    document.querySelectorAll('.prod-checkbox').forEach(cb => cb.checked = master.checked);
    aktualizujPasekMasowy();
}

function aktualizujPasekMasowy() {
    const zaznaczone = document.querySelectorAll('.prod-checkbox:checked');
    const batchBar = document.getElementById('batchBar');
    const selectedCount = document.getElementById('selectedCount');

    if (selectedCount) selectedCount.innerText = `${t('selected_label')} ${zaznaczone.length} ${t('products_label')}`;
    if (batchBar) batchBar.style.display = zaznaczone.length > 0 ? 'flex' : 'none';
}

// Przełącznik Auto-pricing PRZY POJEDYNCZYM produkcie - zapisuje realnie do
// bazy (wcześniej to było tylko console.log, bez żadnego efektu).
async function toggleProductAuto(id, el) {
    const checked = el.checked;
    const data = await apiFetch(`/produkty/${id}/auto`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wlacz: checked })
    });
    if (data?.success) {
        const p = globalnyKatalog.find(pr => pr.id === id);
        if (p) p.auto_pricing = checked ? 1 : 0;
    } else {
        el.checked = !checked; // cofnij wizualnie, jeśli zapis się nie udał
        pokazToast('Nie udało się zapisać zmiany Auto-pricing.', 'error');
    }
}

// Zbiorcze włączenie Auto-pricingu dla zaznaczonych produktów - teraz
// realnie zapisuje do bazy zamiast pokazywać sam toast.
async function masowoWlaczAuto() {
    const zaznaczoneId = [...document.querySelectorAll('.prod-checkbox:checked')].map(cb => parseInt(cb.value, 10));
    if (zaznaczoneId.length === 0) { pokazToast(t('select_products_first'), 'error'); return; }

    const data = await apiFetch('/produkty/auto-wsadowo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: zaznaczoneId, wlacz: true })
    });

    if (data?.success) {
        pokazToast(`Włączono Auto-pricing dla ${data.zaktualizowano} produktów.`, 'success');
        pobierzDane();
    } else {
        pokazToast(data?.error || 'Błąd włączania Auto-pricing.', 'error');
    }
}

// Zbiorcze zatwierdzenie sugerowanych cen AI dla zaznaczonych produktów -
// teraz realnie wywołuje akceptację (i wysyłkę do sklepu) dla każdego
// zaznaczonego produktu, który ma sugestię AI. Wcześniej to był tylko toast.
async function masowoZatwierdzCeny() {
    const zaznaczoneId = [...document.querySelectorAll('.prod-checkbox:checked')].map(cb => parseInt(cb.value, 10));
    if (zaznaczoneId.length === 0) { pokazToast(t('select_products_first'), 'error'); return; }

    const zSugestia = zaznaczoneId
        .map(id => globalnyKatalog.find(pr => pr.id === id))
        .filter(p => p && p.sugerowana_cena);
    if (zSugestia.length === 0) { pokazToast('Żaden z zaznaczonych produktów nie ma sugestii AI do zatwierdzenia.', 'error'); return; }

    pokazPodgladZatwierdzenia(zSugestia);
}

// Pokazuje tabelę "stara cena -> nowa cena" dla każdego produktu, zanim
// cokolwiek zostanie faktycznie zmienione/wysłane do sklepu - zmiany masowe
// są nieodwracalne bez ręcznego cofania, więc warto je zobaczyć przed kliknięciem.
function pokazPodgladZatwierdzenia(produkty) {
    const tbody = document.getElementById('podgladZatwierdzeniaTbody');
    if (tbody) {
        tbody.innerHTML = produkty.map(p => {
            const symbol = getSymbol(p.waluta);
            const stara = parseFloat(p.twoja_cena);
            const nowa = parseFloat(p.sugerowana_cena);
            const zmianaProcent = stara > 0 ? ((nowa - stara) / stara) * 100 : 0;
            const kolorZmiany = zmianaProcent < 0 ? '#f87171' : zmianaProcent > 0 ? '#34d399' : '#94a3b8';
            const strzalka = zmianaProcent < 0 ? '▼' : zmianaProcent > 0 ? '▲' : '–';
            const procentFloor = (p.floor_price_procent !== null && p.floor_price_procent !== undefined) ? p.floor_price_procent : globalnyProcentFloorPrice;
            const ponizejFloor = nowa < stara * (procentFloor / 100);
            return `
                <tr>
                    <td><strong>${p.nazwa}</strong>${ponizejFloor ? '<div style="color:#f87171; font-size:11px; margin-top:2px;">⚠️ poniżej Floor Price</div>' : ''}</td>
                    <td>${stara.toFixed(2)} ${symbol}</td>
                    <td><strong>${nowa.toFixed(2)} ${symbol}</strong></td>
                    <td style="color:${kolorZmiany}; font-weight:600;">${strzalka} ${Math.abs(zmianaProcent).toFixed(1)}%</td>
                </tr>
            `;
        }).join('');
    }

    const modal = document.getElementById('podgladZatwierdzeniaModal');
    if (modal) modal.style.display = 'flex';

    const btn = document.getElementById('podgladZatwierdzeniaBtn');
    if (btn) {
        const nowyBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(nowyBtn, btn);
        nowyBtn.innerText = `Zatwierdź wszystkie (${produkty.length})`;
        nowyBtn.addEventListener('click', async () => {
            if (modal) modal.style.display = 'none';
            let udane = 0, nieudane = 0;
            for (const p of produkty) {
                const wynik = await apiFetch(`/globalne-produkty/akceptuj/${p.id}`, { method: 'POST' });
                if (wynik?.success) udane++; else nieudane++;
            }
            pokazToast(`Zatwierdzono ${udane} cen${nieudane > 0 ? `, ${nieudane} nie powiodło się` : ''}.`, nieudane > 0 ? 'error' : 'success');
            pobierzDane();
        });
    }
}

// ============== EKSPORT CSV ==============
function eksportujCSV() {
    if (!globalnyKatalog.length) { pokazToast('Brak danych do wyeksportowania.', 'error'); return; }

    const naglowki = ['ID', 'Nazwa', 'EAN', 'Waluta', 'Twoja cena', 'Cena konkurencji', 'Sugerowana cena'];
    const wiersze = globalnyKatalog.map(p => [p.id, p.nazwa, p.ean, p.waluta, p.twoja_cena, p.cena_konkurencji, p.sugerowana_cena]);
    const csv = [naglowki, ...wiersze].map(w => w.map(pole => `"${String(pole).replace(/"/g, '""')}"`).join(',')).join('\n');

    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `produkty_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    pokazToast('Wyeksportowano dane do pliku CSV.', 'success');
}

// Uniwersalny import CSV - działa niezależnie od platformy sklepu. Parsujemy
// plik PO STRONIE PRZEGLĄDARKI (prostszy, bezpieczniejszy niż wysyłanie
// surowego pliku na serwer) i wysyłamy gotową tablicę obiektów. Prosty
// parser - nie obsługuje przecinków wewnątrz pól w cudzysłowie (rzadki
// przypadek dla nazw produktów), wystarczający dla typowego eksportu z Excela.
async function importujCSV(inputEl) {
    const plik = inputEl.files?.[0];
    if (!plik) return;

    const tekst = await plik.text();
    const linie = tekst.split(/\r?\n/).filter(l => l.trim());
    if (linie.length < 2) { pokazToast('Plik CSV jest pusty albo zawiera tylko nagłówek.', 'error'); inputEl.value = ''; return; }

    const naglowki = linie[0].split(',').map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));
    const produkty = linie.slice(1).map(linia => {
        const wartosci = linia.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
        const wiersz = {};
        naglowki.forEach((h, i) => { wiersz[h] = wartosci[i]; });
        return wiersz;
    });

    const data = await apiFetch('/produkty/import-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ produkty })
    });

    inputEl.value = ''; // reset, żeby ten sam plik dało się wgrać ponownie, gdyby zaszła taka potrzeba
    if (data?.success) {
        pokazToast(`Zaimportowano ${data.zaimportowano} nowych, zaktualizowano ${data.zaktualizowano} istniejących${data.pominieto > 0 ? ` (pominięto ${data.pominieto} - brak nazwy/ceny albo limit planu)` : ''}.`, 'success');
        pobierzDane();
    } else {
        pokazToast(data?.error || 'Błąd importu CSV.', 'error');
    }
}

// ============== KONFIGURACJA / IMPORT ==============
async function importOferty() {
    const platforma = document.getElementById('platformaSklepu')?.value || 'woocommerce';
    if (platforma === 'csv') {
        pokazToast('Tryb "Inny system (CSV)" nie wymaga zapisu tutaj - użyj przycisków importu/eksportu CSV w zakładce Synchronizacja.', 'info');
        return;
    }

    const storeUrl = document.getElementById('storeUrl')?.value;
    const consumerKey = document.getElementById('consumerKey')?.value;
    const consumerSecret = document.getElementById('consumerSecret')?.value;
    const brakDanych = platforma === 'shopify' ? (!storeUrl || !consumerSecret) : (!storeUrl || !consumerKey || !consumerSecret);
    if (brakDanych) { pokazToast(t('woo_missing_fields'), 'error'); return; }

    const btn = document.getElementById('btn-sync');
    if (btn) { btn.disabled = true; btn.innerText = t('connecting'); }

    const data = await apiFetch('/import-oferty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            platforma,
            storeUrl,
            consumerKey,
            consumerSecret,
            waluta: document.getElementById('currency')?.value,
            rynek: document.getElementById('marketScope')?.value,
            autoRepriceTime: document.getElementById('autoRepriceTime')?.value,
            dailyAutoSync: document.getElementById('dailyAutoSyncToggle')?.checked,
            globalAutoPricing: document.getElementById('globalAutoPricing')?.checked
        })
    });

    if (btn) { btn.disabled = false; btn.innerText = t('btn_save_config'); }

    if (data?.success && data.polaczono) {
        ustawStatusPolaczenia(true);
        pokazToast(data.message, 'success');
        pobierzDane();
    } else if (data?.success && !data.polaczono) {
        ustawStatusPolaczenia(false);
        pokazToast(data.message, 'error');
    } else {
        ustawStatusPolaczenia(false);
        pokazToast(data?.error || t('ai_error'), 'error');
    }
}

async function akceptujCenu(id) {
    const data = await apiFetch(`/globalne-produkty/akceptuj/${id}`, { method: 'POST' });
    if (data?.success) {
        if (data.wyslanoDoSklepu) {
            pokazToast(`${t('price_updated')} ${data.nowaCena} - ${t('sent_to_store')}`, 'success');
        } else if (data.bladWysylki) {
            pokazToast(`${t('price_updated_locally')} ${data.nowaCena}, ${t('store_send_failed')}: ${data.bladWysylki}`, 'error');
        } else {
            pokazToast(`${t('price_updated_locally')} ${data.nowaCena} (${t('no_store_linked')})`, 'info');
        }
        pobierzDane();
    } else {
        pokazToast(data?.error || t('price_update_failed'), 'error');
    }
}

function updateCurrencySymbol() {
    pobierzDane();
}

// ============== SZYBKA SYNCHRONIZACJA I AKCJE SKLEPOWE (zakładka Synchronizacja) ==============
// Poprzednio te trzy przyciski tylko pokazywały toast - poniżej realne
// wywołania backendu.
async function uruchomPelnaSynchronizacje(btnEl) {
    if (btnEl) { btnEl.disabled = true; btnEl.innerText = 'Synchronizuję...'; }
    const data = await apiFetch('/synchronizuj', { method: 'POST' });
    if (btnEl) { btnEl.disabled = false; btnEl.innerText = `▶️ ${t('btn_run_sync')}`; }

    if (data?.success) {
        pokazToast(data.message, 'success');
        pobierzDane();
        pobierzMagazyn();
        if (document.getElementById('tabela-zamowienia')) pobierzZamowienia();
    } else {
        pokazToast(data?.error || 'Błąd synchronizacji.', 'error');
    }
}

async function optymalizujBaze(btnEl) {
    if (btnEl) { btnEl.disabled = true; }
    const data = await apiFetch('/baza/optymalizuj', { method: 'POST' });
    if (btnEl) { btnEl.disabled = false; }

    if (data?.success) pokazToast('Optymalizacja bazy danych zakończona.', 'success');
    else pokazToast(data?.error || 'Błąd optymalizacji bazy.', 'error');
}

function resetCenBazowych() {
    potwierdz('Czy na pewno chcesz przywrócić ceny bazowe (sprzed jakiejkolwiek automatycznej zmiany) dla WSZYSTKICH produktów? Tej akcji nie można cofnąć.', async () => {
        const data = await apiFetch('/ceny/reset-bazowe', { method: 'POST' });
        if (data?.success) {
            pokazToast(`Przywrócono ceny bazowe dla ${data.zresetowano} produktów.`, 'success');
            pobierzDane();
        } else {
            pokazToast(data?.error || 'Błąd przywracania cen bazowych.', 'error');
        }
    });
}

// ============== ZAMÓWIENIA ==============
async function pobierzZamowienia() {
    const tbody = document.getElementById('tabela-zamowienia');
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 40px;"><div class="spinner"></div></td></tr>`;

    const dane = await apiFetch('/zamowienia');
    if (!tbody) return;

    if (!dane || dane.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #94a3b8; padding: 40px;">${t('empty_orders')}</td></tr>`;
        return;
    }

    const kolorStatusu = (status) => ({
        'Nowe': '#94a3b8', 'Opłacone': '#34d399', 'Do wysyłki': '#fbbf24',
        'Wysłane': '#60a5fa', 'Zrealizowane': '#34d399', 'Anulowane': '#f87171'
    }[status] || '#94a3b8');

    tbody.innerHTML = dane.map(z => `
        <tr>
            <td><code>${z.numer}</code></td>
            <td>${z.klient}</td>
            <td>${z.data}</td>
            <td><strong>${z.wartosc} ${getSymbol(z.waluta)}</strong></td>
            <td>
                <select onchange="zmienStatusZamowienia(${z.id}, this.value)" style="background:#0f172a; color:${kolorStatusu(z.status)}; border:1px solid #334155; border-radius:6px; padding:6px 10px; font-weight:600; font-size:13px;">
                    ${['Nowe','Opłacone','Do wysyłki','Wysłane','Zrealizowane','Anulowane'].map(s => `<option value="${s}" ${s === z.status ? 'selected' : ''}>${s}</option>`).join('')}
                </select>
            </td>
            <td><button class="btn-secondary" style="background:#dc2626;" onclick="usunZamowienie(${z.id})">${t('btn_delete')}</button></td>
        </tr>
    `).join('');
}

function otworzModalZamowienia() {
    const m = document.getElementById('addOrderModal'); if (m) m.style.display = 'flex';
}

async function dodajZamowienie() {
    const numer = document.getElementById('newOrderNumer')?.value.trim();
    const klient = document.getElementById('newOrderKlient')?.value.trim();
    const wartosc = document.getElementById('newOrderWartosc')?.value;
    const waluta = document.getElementById('newOrderWaluta')?.value;
    const status = document.getElementById('newOrderStatus')?.value;

    if (!numer || !klient || !wartosc) { pokazToast('Podaj numer, klienta i wartość zamówienia.', 'error'); return; }

    const data = await apiFetch('/zamowienia', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numer, klient, wartosc, waluta, status })
    });

    if (data?.success) {
        document.getElementById('addOrderModal').style.display = 'none';
        ['newOrderNumer', 'newOrderKlient', 'newOrderWartosc'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        pokazToast('Zamówienie dodane.', 'success');
        pobierzZamowienia();
    } else {
        pokazToast(data?.error || 'Błąd podczas dodawania zamówienia.', 'error');
    }
}

async function zmienStatusZamowienia(id, status) {
    const data = await apiFetch(`/zamowienia/${id}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
    });
    if (data?.success) pokazToast(`Status zmieniony na: ${status}`, 'success');
    else pokazToast('Błąd zmiany statusu.', 'error');
}

function usunZamowienie(id) {
    potwierdz('Czy na pewno chcesz usunąć to zamówienie?', async () => {
        const data = await apiFetch(`/zamowienia/${id}`, { method: 'DELETE' });
        if (data?.success) { pokazToast('Zamówienie usunięte.', 'success'); pobierzZamowienia(); }
        else pokazToast('Błąd usuwania zamówienia.', 'error');
    });
}

// ============== MAGAZYN ==============
async function pobierzMagazyn() {
    const tbody = document.getElementById('tabela-magazyn');
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 40px;"><div class="spinner"></div></td></tr>`;

    const dane = await apiFetch('/magazyn');
    if (!tbody) return;

    if (!dane || dane.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #94a3b8; padding: 40px;">${t('empty_stock')}</td></tr>`;
        return;
    }

    tbody.innerHTML = dane.map(m => {
        const niskiStan = m.ilosc < 5;
        const statusHtml = niskiStan
            ? `<span style="color:#f87171;">⚠️ Niski stan</span>`
            : `<span style="color:#34d399;">Optymalny zapas</span>`;
        return `
            <tr>
                <td><strong>${m.nazwa}</strong></td>
                <td><code>${m.sku || '-'}</code></td>
                <td>
                    <input type="number" value="${m.ilosc}" style="width:80px; padding:6px 8px; background:#0f172a; border:1px solid #334155; border-radius:6px; color:#fff;"
                           onchange="aktualizujIlosc(${m.id}, this.value)">
                    szt.
                </td>
                <td>${m.magazyn_nazwa || '-'}</td>
                <td>${statusHtml}</td>
                <td><button class="btn-secondary" style="background:#dc2626;" onclick="usunPozycjeMagazynu(${m.id})">${t('btn_delete')}</button></td>
            </tr>
        `;
    }).join('');
}

function otworzModalMagazynu() {
    const m = document.getElementById('addStockModal'); if (m) m.style.display = 'flex';
}

async function dodajPozycjeMagazynu() {
    const nazwa = document.getElementById('newStockNazwa')?.value.trim();
    const sku = document.getElementById('newStockSku')?.value.trim();
    const ilosc = document.getElementById('newStockIlosc')?.value;
    const magazyn_nazwa = document.getElementById('newStockMagazyn')?.value.trim();

    if (!nazwa || ilosc === '') { pokazToast('Podaj nazwę produktu i ilość.', 'error'); return; }

    const data = await apiFetch('/magazyn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nazwa, sku, ilosc, magazyn_nazwa })
    });

    if (data?.success) {
        document.getElementById('addStockModal').style.display = 'none';
        ['newStockNazwa', 'newStockSku', 'newStockIlosc', 'newStockMagazyn'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        pokazToast('Pozycja magazynowa dodana.', 'success');
        pobierzMagazyn();
    } else {
        pokazToast(data?.error || 'Błąd podczas dodawania pozycji.', 'error');
    }
}

async function aktualizujIlosc(id, ilosc) {
    const data = await apiFetch(`/magazyn/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ilosc })
    });
    if (data?.success) { pokazToast('Ilość zaktualizowana.', 'success'); pobierzMagazyn(); }
    else pokazToast('Błąd aktualizacji ilości.', 'error');
}

function usunPozycjeMagazynu(id) {
    potwierdz('Czy na pewno chcesz usunąć tę pozycję magazynową?', async () => {
        const data = await apiFetch(`/magazyn/${id}`, { method: 'DELETE' });
        if (data?.success) { pokazToast('Pozycja usunięta.', 'success'); pobierzMagazyn(); }
        else pokazToast('Błąd usuwania pozycji.', 'error');
    });
}

// ============== TRYB CENOWY (AI vs reguła) ==============
function pokazUkryjWartoscReguly() {
    const tryb = document.getElementById('trybCenowy')?.value;
    const grupa = document.getElementById('wartoscRegulyGrupa');
    if (grupa) grupa.style.display = (tryb === 'PROCENT_PONIZEJ_KONKURENCJI') ? 'flex' : 'none';
}

async function zmienTrybCenowy() {
    pokazUkryjWartoscReguly();
    const tryb = document.getElementById('trybCenowy')?.value;
    const wartosc = parseFloat(document.getElementById('wartoscReguly')?.value) || 5;

    const data = await apiFetch('/tryb-cenowy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trybCenowy: tryb, wartoscReguly: wartosc })
    });

    if (data?.success) {
        const opis = tryb === 'AI' ? 'AI (analiza modelem językowym)' : tryb === 'DOPASUJ_KONKURENCJE' ? 'dopasowanie do ceny konkurencji' : `${wartosc}% poniżej konkurencji`;
        pokazToast(`Tryb wyliczania cen ustawiony na: ${opis}.`, 'success');
    } else {
        pokazToast(data?.error || 'Błąd zapisu trybu cenowego.', 'error');
    }
}

// Zapisz wartość procentu regulaminowo dopiero po opuszczeniu pola (nie przy
// każdym wpisanym znaku), żeby nie zasypywać backendu zapytaniami.
document.addEventListener('DOMContentLoaded', () => {
    const wartoscInput = document.getElementById('wartoscReguly');
    if (wartoscInput) wartoscInput.addEventListener('change', zmienTrybCenowy);
});

// ============== KREATOR PIERWSZEGO URUCHOMIENIA (onboarding) ==============
let onboardingAktualnyKrok = 0;
const ONBOARDING_KROKI = [
    {
        tytul: 'Witaj w PriceAI Cloud 👋',
        tresc: `<p>To narzędzie automatycznie porównuje Twoje ceny z konkurencją i podpowiada, jak je ustawić - AI generuje sugestię z uzasadnieniem, a Ty decydujesz, czy ją zatwierdzić.</p>
                <p>Ten krótki kreator pokaże Ci, jak podłączyć swój sklep WooCommerce. Zajmie to około 2 minut.</p>`
    },
    {
        tytul: 'Krok 1: Znajdź klucze API w WooCommerce',
        tresc: `<p>W panelu administracyjnym Twojego sklepu WordPress przejdź do:</p>
                <p style="background:#0f172a; padding:10px 14px; border-radius:8px; font-family:monospace; font-size:13px;">WooCommerce → Ustawienia → Zaawansowane → REST API → Dodaj klucz</p>
                <p>Nadaj uprawnienia <strong>przynajmniej "Odczyt"</strong> i kliknij "Generuj klucz". Otrzymasz dwa ciągi znaków: <strong>Consumer Key</strong> (zaczyna się od <code>ck_</code>) i <strong>Consumer Secret</strong> (zaczyna się od <code>cs_</code>).</p>
                <p style="color:#fbbf24; font-size:13px;">⚠️ Adres sklepu musi zaczynać się od <strong>https://</strong> - WooCommerce nie zaakceptuje kluczy przez zwykłe http://.</p>`
    },
    {
        tytul: 'Krok 2: Wklej dane w panelu konfiguracji',
        tresc: `<p>Po zamknięciu tego okna zobaczysz sekcję "⚙️ Konfiguracja integracji" na górze strony. Wklej tam:</p>
                <ul style="padding-left:20px; margin:8px 0;">
                    <li>Adres sklepu (np. https://twojsklep.pl)</li>
                    <li>Consumer Key</li>
                    <li>Consumer Secret</li>
                </ul>
                <p>Potem kliknij <strong>"Zapisz konfigurację i uruchom skanowanie"</strong> - Twoje produkty i stany magazynowe zaimportują się automatycznie.</p>`
    },
    {
        tytul: 'To wszystko! 🎉',
        tresc: `<p>Kraj i waluta wykrywają się same - nie musisz nic dodatkowo ustawiać.</p>
                <p>Jeśli nie masz jeszcze sklepu do podłączenia, możesz też dodać produkty ręcznie przyciskiem "Dodaj produkt" i przetestować narzędzie na nich.</p>
                <p>Powodzenia! W razie pytań kliknij 🤖 w prawym dolnym rogu - to wbudowany asystent pomocy.</p>`
    }
];

function renderujKrokOnboardingu() {
    const krok = ONBOARDING_KROKI[onboardingAktualnyKrok];
    const tytulEl = document.getElementById('onboardingTytul');
    const trescEl = document.getElementById('onboardingTresc');
    const wsteczBtn = document.getElementById('onboardingWstecz');
    const dalejBtn = document.getElementById('onboardingDalej');
    if (tytulEl) tytulEl.innerText = krok.tytul;
    if (trescEl) trescEl.innerHTML = krok.tresc;
    if (wsteczBtn) wsteczBtn.style.display = onboardingAktualnyKrok > 0 ? 'inline-block' : 'none';
    if (dalejBtn) dalejBtn.innerText = (onboardingAktualnyKrok === ONBOARDING_KROKI.length - 1) ? 'Zacznij →' : 'Dalej →';
}

function onboardingKrok(kierunek) {
    onboardingAktualnyKrok += kierunek;
    if (onboardingAktualnyKrok >= ONBOARDING_KROKI.length) {
        zakonczOnboarding();
        return;
    }
    if (onboardingAktualnyKrok < 0) onboardingAktualnyKrok = 0;
    renderujKrokOnboardingu();
}

function pomijOnboarding() {
    zakonczOnboarding();
}

async function zakonczOnboarding() {
    const modal = document.getElementById('onboardingModal');
    if (modal) modal.style.display = 'none';
    await apiFetch('/onboarding/zakoncz', { method: 'POST' });
}

function otworzOnboardingJesliPotrzebny(dane) {
    if (dane.demo) return; // gościom DEMO nie pokazujemy - i tak mają przykładowe dane od razu
    if (dane.onboarding_zakonczony) return;
    if (dane.liczba_produktow > 0) return; // ma już produkty - nie jest to pierwsze uruchomienie
    onboardingAktualnyKrok = 0;
    renderujKrokOnboardingu();
    const modal = document.getElementById('onboardingModal');
    if (modal) modal.style.display = 'flex';
}