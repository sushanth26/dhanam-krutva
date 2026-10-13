from app import cache_util
from app.cache_util import cache_put


def test_cache_put_drops_stale_and_oldest_entries(monkeypatch):
    clock = iter([100.0, 101.0, 102.0, 500.0])
    monkeypatch.setattr(cache_util.time, "time", lambda: next(clock))
    cache = {}
    cache_put(cache, "a", 1, max_age=300, max_items=2)
    cache_put(cache, "b", 2, max_age=300, max_items=2)
    cache_put(cache, "c", 3, max_age=300, max_items=2)
    assert set(cache) == {"b", "c"}  # oldest evicted past max_items
    cache_put(cache, "d", 4, max_age=300, max_items=2)
    assert set(cache) == {"d"}  # b and c are older than 300s
