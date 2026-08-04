async function analizujProdukt() {
    const url = document.getElementById('productUrl').value;
    const myPrice = parseFloat(document.getElementById('myPrice').value);
    const loader = document.getElementById('loader');
    const resultsCard = document.getElementById('resultsCard');

    if (!url || isNaN(myPrice)) {
        alert("Wpisz poprawny link oraz swoją obecną cenę!");
        return;
    }

    // Pokazujemy ładowanie
    loader.style.display = 'block';
    resultsCard.style.display = 'none';

    // Udawany czas odpowiedzi (w kolejnym kroku zastąpimy to zapytaniem do prawdziwego backendu)
    setTimeout(() => {
        loader.style.display = 'none';
        resultsCard.style.display = 'block';

        // Przykładowy wynik pobrany ze skanowania
        const competitorPrice = myPrice + 5.00; 
        const isLowStock = true;

        document.getElementById('competitorPrice').textContent = `${competitorPrice.toFixed(2)} zł`;
        document.getElementById('stockStatus').textContent = isLowStock ? "Ostatnie sztuki! ⚠️" : "Wysoka dostępność";

        // Sugestia generowana przez AI
        let aiText = "";
        if (isLowStock && competitorPrice > myPrice) {
            aiText = `Konkurencja ma wyższą cenę (${competitorPrice} zł) i wyprzedaje magazyn. Zalecenie AI: Podnieś cenę o 3.50 zł. Zwiększysz marżę, a klienci i tak kupią u Ciebie!`;
        } else {
            aiText = `Rynek jest stabilny. Utrzymaj obecną cenę ${myPrice} zł.`;
        }

        document.getElementById('aiSuggestion').textContent = aiText;
    }, 2000);
}