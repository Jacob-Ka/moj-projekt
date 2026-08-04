function sprawdzCene() {
    const nazwa = document.getElementById('nazwa').value || 'Produkt';
    const stara = parseFloat(document.getElementById('staraCena').value);
    const nowa = parseFloat(document.getElementById('nowaCena').value);
    const wynikDiv = document.getElementById('wynik');

    if (isNaN(stara) || isNaN(nowa)) {
        wynikDiv.style.display = 'block';
        wynikDiv.className = 'wynik-box drozej';
        wynikDiv.innerHTML = 'Wpisz poprawne liczby w obu polach cen!';
        return;
    }

    const roznica = (stara - nowa).toFixed(2);
    const procent = Math.abs(((roznica / stara) * 100)).toFixed(1);

    wynikDiv.style.display = 'block';

    if (nowa < stara) {
        wynikDiv.className = 'wynik-box taniej';
        wynikDiv.innerHTML = `🎉 Super okazja! <strong>${nazwa}</strong> jest tańszy o <strong>${roznica} zł</strong> (${procent}% taniej).`;
    } else if (nowa > stara) {
        const podwyzka = Math.abs(roznica).toFixed(2);
        wynikDiv.className = 'wynik-box drozej';
        wynikDiv.innerHTML = `⚠️ Drożej! <strong>${nazwa}</strong> podrożał o <strong>${podwyzka} zł</strong> (+${procent}%).`;
    } else {
        wynikDiv.className = 'wynik-box bez-zmian';
        wynikDiv.innerHTML = `Brak zmian. Cena <strong>${nazwa}</strong> jest taka sama.`;
    }
}