"""Contratto su data/matches.json: una squadra = un nome, e gli xG non spariscono in silenzio.

Prima di questo file nulla si accorgeva di due difetti che il dataset aveva entrambi:

1. IDENTITÀ SPEZZATE. Bundesliga 2425 conteneva 22 nomi di squadra per un campionato da 18 e
   LaLiga 28 per uno da 20, perché ESPN e Football-Data.co.uk scrivono lo stesso club in modo
   diverso e merge_matches() deduplica sui nomi. Conseguenza diretta e invisibile: la stessa
   partita reale presente due volte (esp.1 2425 aveva 411 righe invece di 380) e la storia di
   un club divisa fra due identità, ciascuna con Elo, forma e medie calcolate su un frammento.

2. COPERTURA xG CROLLATA IN DUE LEGHE. esp.1 al 35% e ger.1 al 34% contro il 90-99% della
   Serie A. L'esponente xG è il più alto del modello (0.43 in attacco, 0.45 in difesa): dove
   l'xG manca, xgValue() ricade su 0.16 + 0.026·tiri + 0.19·tiriInPorta, cioè su due
   variabili già presenti nel modello con esponenti propri. In quelle leghe il modello non
   pesava xG 0.43 e tiri 0.25, pesava tiri 0.68 con un'etichetta diversa.

Nessuno dei due difetti solleva un'eccezione: producono un numero plausibile. Questo file è
la rete che li intercetta, ed è scritto per fallire sul dataset che li conteneva.
"""
import json
import unittest
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATASET = ROOT / "data" / "matches.json"

# Numero di squadre per campionato. Serve come limite superiore al numero di identità
# ammesse in una stagione: più nomi che squadre significa per forza un club contato due volte.
LEAGUE_SIZE = {"eng.1": 20, "esp.1": 20, "ita.1": 20, "ger.1": 18, "fra.1": 18}

# Soglia minima di copertura xG per lega su una stagione conclusa. Non è un obiettivo di
# qualità arbitrario: sotto questa quota la feature con l'esponente più alto del modello è
# per la maggioranza delle partite un proxy dei tiri, e ogni confronto fra configurazioni
# misurato su quella lega sta misurando un'altra cosa.
MIN_XG_COVERAGE = 0.70

# Una stagione è "conclusa" ai fini di questo contratto se ha almeno questa quota di partite
# rispetto al calendario pieno: le stagioni appena iniziate hanno pochi risultati e una
# copertura instabile, e farle fallire sarebbe rumore, non un difetto.
COMPLETE_SEASON_RATIO = 0.9


def load_payload() -> dict:
    return json.loads(DATASET.read_text(encoding="utf8"))


def completed_domestic(payload: dict) -> list[dict]:
    return [
        item for item in payload["matches"]
        if str(item.get("competition_id")) in LEAGUE_SIZE
        and item.get("home_goals") is not None
        and item.get("away_goals") is not None
    ]


class TeamIdentityContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.payload = load_payload()
        self.matches = completed_domestic(self.payload)

    def test_no_league_season_has_more_identities_than_teams(self) -> None:
        identities: dict[tuple[str, str], set[str]] = defaultdict(set)
        for item in self.matches:
            key = (str(item["competition_id"]), str(item.get("season")))
            identities[key].add(str(item["home_team"]))
            identities[key].add(str(item["away_team"]))
        offenders = [
            f"{competition} {season}: {len(names)} identità per un campionato da "
            f"{LEAGUE_SIZE[competition]} — {sorted(names)}"
            for (competition, season), names in sorted(identities.items())
            if len(names) > LEAGUE_SIZE[competition]
        ]
        self.assertEqual(offenders, [], "Identità di club duplicate:\n  " + "\n  ".join(offenders))

    def test_no_team_plays_more_matches_than_the_calendar_allows(self) -> None:
        # Il controllo simmetrico del precedente: due righe per la stessa partita gonfiano il
        # conteggio di una squadra anche quando i due nomi coincidono per caso su un lato.
        played: dict[tuple[str, str, str], int] = defaultdict(int)
        for item in self.matches:
            for side in ("home_team", "away_team"):
                played[(str(item["competition_id"]), str(item.get("season")), str(item[side]))] += 1
        offenders = []
        for (competition, season, team), count in sorted(played.items()):
            limit = 2 * (LEAGUE_SIZE[competition] - 1)
            if count > limit:
                offenders.append(f"{competition} {season} {team}: {count} gare, il calendario ne prevede {limit}")
        self.assertEqual(offenders, [], "Partite duplicate:\n  " + "\n  ".join(offenders))

    def test_no_two_names_differ_only_by_spelling(self) -> None:
        # Contratto generale, complementare al precedente: TEAM_ALIASES copre le
        # abbreviazioni (serve sapere che "Ath Madrid" è l'Atletico), ma le divergenze di
        # sola grafia — "Malaga"/"Málaga", "St. Pauli"/"St Pauli" — sono riconoscibili senza
        # sapere nulla di calcio, e vanno intercettate da una regola, non da una lista.
        import sys as _sys
        _sys.path.insert(0, str(ROOT / "scripts"))
        from update_europe_data import _fold_team_name

        grouped = defaultdict(set)
        for item in self.matches:
            for side in ("home_team", "away_team"):
                grouped[_fold_team_name(str(item[side]))].add(str(item[side]))
        offenders = [sorted(names) for names in grouped.values() if len(names) > 1]
        self.assertEqual(offenders, [], f"Nomi che differiscono solo per grafia: {offenders}")

    def test_no_duplicate_match_rows(self) -> None:
        seen: dict[tuple[str, str, str, str], int] = defaultdict(int)
        for item in self.matches:
            seen[(str(item["competition_id"]), str(item["date"]), str(item["home_team"]), str(item["away_team"]))] += 1
        duplicates = [key for key, count in seen.items() if count > 1]
        self.assertEqual(duplicates, [], f"{len(duplicates)} righe partita duplicate: {duplicates[:10]}")


# Coppie di nomi in cui uno CONTIENE l'altro senza essere lo stesso club. Sono i falsi
# positivi noti del rilevatore sotto, e ciascuna è un fatto verificabile, non una scusa:
# l'Inter Escaldes è andorrano, l'Inter Turku finlandese, l'Arsenal Tivat montenegrino, la
# Dinamo Brest bielorussa. Nessuno dei quattro ha niente a che vedere con il club dei Big
# Five il cui nome contengono.
DISTINCT_CLUBS_SHARING_A_WORD = {
    ("Inter Escaldes", "Inter"),
    ("Inter Turku", "Inter"),
    ("Arsenal Tivat", "Arsenal"),
    ("Dynamo Brest", "Brest"),
}

# Nomi che l'API UEFA usa per un club diverso da quello che indicherebbero altrove, risolti
# in update_uefa_data.UEFA_TEAM_OVERRIDES. Nessuno deve sopravvivere in una riga di coppa.
EUROPE_IDS = {"ucl", "uel", "uecl"}


class SplitIdentityAcrossCompetitionsTests(unittest.TestCase):
    """Un club spezzato fra coppe e campionato: due identità, ciascuna con metà della storia.

    È una variante del difetto 1 che nessuno dei contratti precedenti poteva vedere. Quelli
    contano le identità DENTRO una lega e per stagione: un nome che compare solo nelle coppe
    non gonfia nessun conteggio di lega, e non collide per grafia con la sua controparte
    domestica perché le due parole sono diverse ("Atleti" contro "Atletico Madrid").

    Il dataset del 27/08/2026 ne conteneva tre, tutti invisibili a ogni misura domestica
    perché una previsione di campionato filtra via le coppe:

      Atletico Madrid   116 gare domestiche  +  36 come "Atleti"
      Dortmund          102 gare domestiche  +  37 come "B. Dortmund"
      PSG               103 gare domestiche  +  46 come "Paris"

    Il terzo era il peggiore: "Paris" conteneva ANCHE le 35 gare di Ligue 1 del Paris FC, un
    club diverso, quindi nelle previsioni europee il PSG era una chimera di due squadre.
    Ricomporli vale +0.0145 di log loss in Champions League su 812 gare.
    """

    def setUp(self) -> None:
        self.payload = load_payload()
        self.names_by_group: dict[str, set[str]] = {"europe": set(), "domestic": set()}
        for item in self.payload["matches"]:
            competition = str(item.get("competition_id"))
            group = "europe" if competition in EUROPE_IDS else "domestic" if competition in LEAGUE_SIZE else None
            if group is None:
                continue
            for side in ("home_team", "away_team"):
                if item.get(side):
                    self.names_by_group[group].add(str(item[side]))

    def test_every_known_alias_is_already_resolved_in_the_dataset(self) -> None:
        # Il controllo più forte e più economico: normalize_team() deve essere l'identità su
        # ogni nome presente nel dataset. Se non lo è, il dataset porta una grafia che la
        # pipeline sa già ricondurre — cioè è stato generato prima della correzione, oppure
        # una fonte ha aggirato la normalizzazione. Avrebbe intercettato "Atleti" e
        # "B. Dortmund" nell'istante in cui gli alias sono stati dichiarati.
        import sys as _sys
        _sys.path.insert(0, str(ROOT / "scripts"))
        from update_europe_data import normalize_team

        offenders = sorted(
            f"{name!r} -> {normalize_team(name)!r}"
            for group in self.names_by_group.values()
            for name in group
            if normalize_team(name) != name
        )
        self.assertEqual(offenders, [], f"Nomi non canonici rimasti nel dataset: {offenders}")

    def test_no_uefa_only_name_shadows_a_domestic_club(self) -> None:
        # Il rilevatore che ha trovato l'Atletico: un nome che esiste SOLO nelle coppe e le
        # cui parole significative sono tutte contenute in un nome domestico è quasi sempre
        # lo stesso club scritto diversamente. I casi in cui non lo è sono pochi, noti ed
        # elencati sopra — tenerli in una lista esplicita costa meno che perdere il segnale.
        import re as _re
        import unicodedata as _ud

        def words(name: str) -> list[str]:
            folded = "".join(
                character for character in _ud.normalize("NFD", name.lower())
                if _ud.category(character) != "Mn"
            ).replace("ø", "o")
            stop = {"fc", "cf", "ac", "as", "sc", "de", "cd", "ud", "rc", "b", "fk", "sk", "bv"}
            return [word for word in _re.split(r"[^a-z0-9]+", folded) if word and word not in stop]

        europe_only = self.names_by_group["europe"] - self.names_by_group["domestic"]
        offenders = []
        for cup_name in sorted(europe_only):
            cup_words = words(cup_name)
            if not cup_words:
                continue
            for domestic_name in sorted(self.names_by_group["domestic"]):
                domestic_words = words(domestic_name)
                if not domestic_words or cup_name == domestic_name:
                    continue
                shared = all(word in domestic_words for word in cup_words)
                if shared and (cup_name, domestic_name) not in DISTINCT_CLUBS_SHARING_A_WORD:
                    offenders.append(f"{cup_name!r} (solo coppe) ~ {domestic_name!r} (campionato)")
        self.assertEqual(
            offenders, [],
            "Possibili identità spezzate fra coppe e campionato. Se sono davvero club "
            f"distinti, aggiungili a DISTINCT_CLUBS_SHARING_A_WORD con la ragione: {offenders}",
        )

    def test_uefa_source_overrides_do_not_survive(self) -> None:
        # "Paris" non è risolvibile da normalize_team(), perché in Ligue 1 è il Paris FC.
        # L'unica rete possibile è verificare che non compaia in una riga di coppa.
        import sys as _sys
        _sys.path.insert(0, str(ROOT / "scripts"))
        from update_uefa_data import UEFA_TEAM_OVERRIDES

        offenders = sorted(self.names_by_group["europe"] & set(UEFA_TEAM_OVERRIDES))
        self.assertEqual(
            offenders, [],
            f"Nomi dell'API UEFA non risolti nelle righe di coppa: {offenders}. "
            "Sono ambigui: fuori dalle coppe indicano un altro club.",
        )


class XgCoverageContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.payload = load_payload()
        self.matches = completed_domestic(self.payload)

    def coverage_by_league_season(self) -> dict[tuple[str, str], tuple[int, int]]:
        counters: dict[tuple[str, str], list[int]] = defaultdict(lambda: [0, 0])
        for item in self.matches:
            cell = counters[(str(item["competition_id"]), str(item.get("season")))]
            cell[1] += 1
            if item.get("home_xg") is not None and item.get("away_xg") is not None:
                cell[0] += 1
        return {key: (value[0], value[1]) for key, value in counters.items()}

    def test_every_completed_season_has_enough_real_xg(self) -> None:
        offenders = []
        for (competition, season), (with_xg, total) in sorted(self.coverage_by_league_season().items()):
            # girone doppio: ogni squadra incontra le altre in casa e fuori
            full_calendar = LEAGUE_SIZE[competition] * (LEAGUE_SIZE[competition] - 1)
            if total < full_calendar * COMPLETE_SEASON_RATIO:
                continue  # stagione in corso: copertura non ancora significativa
            ratio = with_xg / total
            if ratio < MIN_XG_COVERAGE:
                offenders.append(f"{competition} {season}: {100 * ratio:.1f}% ({with_xg}/{total}), soglia {100 * MIN_XG_COVERAGE:.0f}%")
        self.assertEqual(
            offenders,
            [],
            "Copertura xG sotto soglia — in queste leghe la feature con l'esponente più alto "
            "del modello è un proxy dei tiri:\n  " + "\n  ".join(offenders),
        )

    def test_no_single_team_is_left_without_xg(self) -> None:
        # La soglia per lega non basta: una sola squadra su venti con lo slug Understat
        # sbagliato costa il 10% di copertura e lascia la lega sopra soglia. È successo con
        # "Hellas Verona" (Understat la chiama "Verona"): la Serie A restava al 90% e il
        # test di lega passava, mentre per QUELLA squadra il modello usava il proxy dei
        # tiri in ogni singola partita. È lo stesso principio di R5 applicato alla fonte:
        # un aggregato che nasconde un buco su un segmento non è una copertura.
        counters: dict[tuple[str, str, str], list[int]] = defaultdict(lambda: [0, 0])
        for item in self.matches:
            has_xg = item.get("home_xg") is not None and item.get("away_xg") is not None
            for side in ("home_team", "away_team"):
                cell = counters[(str(item["competition_id"]), str(item.get("season")), str(item[side]))]
                cell[1] += 1
                cell[0] += 1 if has_xg else 0
        offenders = []
        for (competition, season, team), (with_xg, total) in sorted(counters.items()):
            if total < LEAGUE_SIZE[competition]:  # squadra con poche gare: stagione in corso
                continue
            if with_xg / total < 0.5:
                offenders.append(f"{competition} {season} {team}: {100 * with_xg / total:.0f}% ({with_xg}/{total})")
        self.assertEqual(
            offenders,
            [],
            "Squadre senza xG reali — quasi sempre uno slug Understat mancante:\n  " + "\n  ".join(offenders),
        )

    def test_xg_values_are_plausible_where_present(self) -> None:
        # Una regressione futura potrebbe "coprire" il 100% delle partite scrivendo zeri o
        # copiando i gol: il contratto sulla copertura da solo non se ne accorgerebbe.
        suspicious = 0
        total = 0
        for item in self.matches:
            home, away = item.get("home_xg"), item.get("away_xg")
            if home is None or away is None:
                continue
            total += 1
            if not (0 <= float(home) <= 8) or not (0 <= float(away) <= 8):
                suspicious += 1
        self.assertGreater(total, 0, "nessun xG nel dataset")
        self.assertEqual(suspicious, 0, f"{suspicious}/{total} valori xG fuori da [0, 8]")

    def test_xg_is_not_merely_a_copy_of_goals(self) -> None:
        exact = 0
        total = 0
        for item in self.matches:
            home, away = item.get("home_xg"), item.get("away_xg")
            if home is None or away is None:
                continue
            total += 1
            if float(home) == float(item["home_goals"]) and float(away) == float(item["away_goals"]):
                exact += 1
        self.assertGreater(total, 0, "nessun xG nel dataset")
        self.assertLess(exact / total, 0.05, f"{exact}/{total} righe hanno xG identici ai gol: sospetto di fallback mascherato")


if __name__ == "__main__":
    unittest.main()
