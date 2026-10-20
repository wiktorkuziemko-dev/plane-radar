# ✈️ Plane Radar

Mobilna aplikacja webowa (PWA), która na żywo pokazuje samoloty lecące nad Twoim domem:
przewoźnika, numer lotu, trasę, wysokość, prędkość, prędkość pionową, typ samolotu i rejestrację.

## Funkcje
- Radar z samolotami wokół domu: ikony obrócone zgodnie z kursem, kolor zależny od wysokości, krótki ślad przelotu
- Karty lotów posortowane według odległości, szczegóły po dotknięciu
- Lokalizacja z GPS lub wpisana ręcznie, regulowany promień (3–60 km)
- Odświeżanie co 5 s, wstrzymywane, gdy aplikacja jest w tle
- Można ją zainstalować na ekranie głównym telefonu („Dodaj do ekranu początkowego”)

## Źródła danych (darmowe, bez klucza API)
| Dane | Źródło |
|---|---|
| Pozycje samolotów (ADS-B) | [adsb.lol](https://adsb.lol) albo [airplanes.live](https://airplanes.live), z automatycznym przełączeniem na drugie, gdy pierwsze nie odpowiada |
| Przewoźnik i trasa po znaku wywoławczym | [adsbdb.com](https://www.adsbdb.com) |
| Logotypy linii | pics.avs.io, a gdy logo się nie wczyta, kolorowa plakietka z kodem ICAO |

Te serwisy są przeznaczone do użytku niekomercyjnego i mają limity zapytań (około 1 na sekundę).

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
- `index.html`: układ strony
- `style.css`: wygląd (ciemny motyw, mobile-first)
- `app.js`: pobieranie danych, radar, lista, ustawienia, tryb demo
- `sw.js`, `manifest.webmanifest`, `icons/`: obsługa PWA
