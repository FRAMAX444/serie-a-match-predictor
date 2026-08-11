import time
from understat_team_api import resolve_slug, fetch_team_data, fetch_league_matches_via_team_api
from update_europe_data import normalize_team

# Sostituisci 'esp.1' con l'id della lega che stava bloccando (es. 'esp.1' per LaLiga)
league_teams = sorted({"Real Madrid","Barcelona","Atletico Madrid","Sevilla","Real Sociedad"})  # metti qui le squadre reali se le conosci
year = 2026

teams = league_teams
print("Teams to query:", teams)
start = time.time()
for team in teams:
    slug = resolve_slug(team)
    print(f"Fetching {team} -> slug {slug}")
    t0 = time.time()
    try:
        payload = fetch_team_data(slug, year)
        print(f"  OK ({time.time()-t0:.1f}s): keys={list(payload.keys())[:5]}")
    except Exception as e:
        print(f"  FAIL ({time.time()-t0:.1f}s): {e}")
    time.sleep(0.1)
print("Total time:", time.time()-start)