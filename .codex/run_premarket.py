import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from app.config import get_settings
from app.market_data import build_live_prices, cloud_status
from app.watchlists import WatchlistStore
from app.webull_service import WebullService

root = Path.cwd()
settings = get_settings()
watchlists = WatchlistStore(root / '.watchlists.json').all()
quotes_by = {}
for w in watchlists:
    result = build_live_prices(WebullService(settings), ','.join(w['symbols']))
    if not result.get('ok'):
        raise RuntimeError(json.dumps(result.get('errors', result)))
    quotes_by[w['id']] = result.get('quotes', [])

rows = []
seen = set()
for w in watchlists:
    for q in quotes_by.get(w['id'], []):
        symbol = q.get('symbol')
        price = q.get('price')
        pd = q.get('previous_day') or {}
        high, low = pd.get('high'), pd.get('low')
        if not all(isinstance(x, (int, float)) and x == x for x in (price, high, low)):
            continue
        trend = cloud_status(q.get('ema_10m'), ['5', '12'], ['34', '50'])
        if symbol in seen:
            continue
        if price > high and trend == 'Bullish':
            action, trigger, dist = 'Long', 'Above YH', (price-high)/high*100
        elif price < low and trend == 'Bearish':
            action, trigger, dist = 'Short', 'Below YL', (low-price)/low*100
        else:
            continue
        seen.add(symbol)
        rows.append({'symbol': symbol, 'action': action, 'trend': trend, 'price': price,
                     'previousHigh': high, 'previousLow': low, 'trigger': trigger,
                     'distancePct': dist, 'watchlistName': w['name']})
rows.sort(key=lambda r: (0 if r['trend']=='Bullish' else 1, -r['distancePct'], r['symbol']))

path = root / '.codex' / 'premarket_shortlist_snapshot.json'
path.parent.mkdir(exist_ok=True)
now = datetime.now(ZoneInfo('America/Chicago')).isoformat()
current = {'timestamp': now, 'row_signatures': [f"{r['symbol']}|{r['action']}|{r['trigger']}|{r['trend']}" for r in rows], 'rows': rows}
previous = json.loads(path.read_text()) if path.exists() else None
path.write_text(json.dumps(current, indent=2) + '\n')
if previous is None:
    print('BASELINE')
    raise SystemExit
old = { (r.get('symbol'), r.get('action')): r for r in previous.get('rows', []) }
new = { (r.get('symbol'), r.get('action')): r for r in rows }
old_by_symbol = {r.get('symbol'): r for r in previous.get('rows', [])}
new_by_symbol = {r.get('symbol'): r for r in rows}
came = [new[k] for k in new.keys() - old.keys() if k[0] not in old_by_symbol]
moved = [old[k] for k in old.keys() - new.keys() if k[0] not in new_by_symbol]
changed = [(old_by_symbol[s], new_by_symbol[s]) for s in old_by_symbol.keys() & new_by_symbol.keys() if old_by_symbol[s].get('action') != new_by_symbol[s].get('action')]
if came or moved or changed:
    def fmt(r): return f"{r['symbol']} {r['action']} ${r['price']:.2f} {r['trigger']} {r['distancePct']:.2f}% {r['trend']} ({r['watchlistName']})"
    if came: print('Came in\n' + '\n'.join(fmt(r) for r in came))
    if moved: print('Moved out\n' + '\n'.join(fmt(r) for r in moved))
    if changed: print('Changed side\n' + '\n'.join(f"{a['symbol']} {a['action']} -> {b['action']} ${b['price']:.2f} {b['trigger']} {b['distancePct']:.2f}% {b['trend']} ({b['watchlistName']})" for a,b in changed))
else: print('NO_CHANGE')
