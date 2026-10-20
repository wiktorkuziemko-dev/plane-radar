# ✈️ Plane Radar

Mobilna aplikacja webowa w **jednym pliku `index.html`**, która na żywo pokazuje samoloty lecące nad Twoim domem:
przewoźnika, numer lotu, trasę, wysokość, prędkość, prędkość pionową, typ samolotu i rejestrację.

## Funkcje
- Radar z samolotami wokół domu: ikony obrócone zgodnie z kursem, kolor zależny od wysokości, krótki ślad przelotu
- Karty lotów posortowane według odległości, szczegóły po dotknięciu
- Lokalizacja z GPS lub wpisana ręcznie, regulowany promień (3–60 km)
- Odświeżanie co 5 s, wstrzymywane, gdy aplikacja jest w tle
- Można ją dodać do ekranu głównego telefonu („Dodaj do ekranu początkowego”)

## Źródła danych (darmowe, bez klucza API)
| Dane | Źródło |
|---|---|
| Pozycje samolotów (ADS-B), przez serwer pośredniczący | [adsb.lol](https://adsb.lol) albo [airplanes.live](https://airplanes.live), z automatycznym przełączeniem na drugie, gdy pierwsze nie odpowiada |
| Przewoźnik i trasa po znaku wywoławczym | [adsbdb.com](https://www.adsbdb.com) |
| Logotypy linii | pics.avs.io, a gdy logo się nie wczyta, kolorowa plakietka z kodem ICAO |

Te serwisy są przeznaczone do użytku niekomercyjnego i mają limity zapytań (około 1 na sekundę).

## Serwer pośredniczący (wymagany)
adsb.lol, airplanes.live i adsbdb.com nie wysyłają nagłówków CORS, więc przeglądarka blokuje zapytania wysłane prosto ze strony.
Dlatego aplikacja łączy się z nimi przez mały Cloudflare Worker: plik [`worker/plane-radar-proxy.js`](worker/plane-radar-proxy.js).
Darmowy plan Cloudflare daje 100 000 zapytań dziennie. Aplikacja otwarta przez całą dobę zużywa około 17 000.

1. Załóż darmowe konto na https://dash.cloudflare.com.
2. **Workers & Pages → Create → Create Worker**. Nazwij go `plane-radar-proxy` i kliknij **Deploy**.
3. **Edit code**: usuń przykładowy kod, wklej zawartość `worker/plane-radar-proxy.js` i kliknij **Deploy**.
4. Skopiuj adres Workera, np. `https://plane-radar-proxy.<twoja-nazwa>.workers.dev`.
5. W aplikacji otwórz ⚙️ Ustawienia, wklej adres w polu **Serwer pośredniczący** i zapisz.
   Możesz też wpisać go na stałe w stałej `PROXY_URL` w `index.html`.

Worker przyjmuje zapytania tylko ze stron wymienionych w `ALLOWED_ORIGINS`. Jeśli hostujesz aplikację gdzie indziej, dopisz tam jej adres.

## Uruchomienie lokalne
```bash
python3 -m http.server 8000
# http://localhost:8000          dane na żywo
# http://localhost:8000/?demo    dane demonstracyjne (bez internetu)
```

## Publikacja na GitHub Pages
Settings → Pages → Source: *Deploy from a branch* → `main` / `(root)`.
Aplikacja będzie dostępna pod `https://<login>.github.io/plane-radar/`.

## Struktura
Cała aplikacja (HTML, CSS, JavaScript i ikona) jest w `index.html`. Serwer pośredniczący jest w `worker/plane-radar-proxy.js`. Można go też otworzyć bezpośrednio z dysku albo wrzucić na dowolny hosting.
